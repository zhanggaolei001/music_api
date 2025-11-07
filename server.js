const fs = require('fs')
const path = require('path')
const express = require('express')
const axios = require('axios')
const { pipeline } = require('stream/promises')
const request = require('./util/request')
const packageJSON = require('./package.json')
const exec = require('child_process').exec
const cache = require('./util/apicache').middleware
const { cookieToJson } = require('./util/index')
const fileUpload = require('express-fileupload')
const decode = require('safe-decode-uri-component')
const { biliRequest } = require('./util/biliRequest')
const { registerBiliApis } = require('./util/biliApiHandler')
const biliApiConfigs = require('./bili/biliApiConfigs')
const songUrlModule = require('./module/song_url')

const AUDIO_CACHE_DIR =
  process.env.AUDIO_CACHE_DIR ||
  path.join(process.cwd(), 'audio-cache')
const AUDIO_CACHE_TTL_SECONDS = Number(
  process.env.AUDIO_CACHE_TTL_SECONDS || '3600',
)
const AUDIO_CACHE_MAX_SIZE_MB = Number(
  process.env.AUDIO_CACHE_MAX_SIZE_MB || '0',
)
const AUDIO_CACHE_TTL_MS =
  AUDIO_CACHE_TTL_SECONDS > 0 ? AUDIO_CACHE_TTL_SECONDS * 1000 : 0
const AUDIO_CACHE_MAX_BYTES =
  AUDIO_CACHE_MAX_SIZE_MB > 0 ? AUDIO_CACHE_MAX_SIZE_MB * 1024 * 1024 : 0

const inflightDownloads = new Map()

/**
 * Ensure cache directory exists.
 * @returns {Promise<void>}
 */
async function ensureCacheDir() {
  await fs.promises.mkdir(AUDIO_CACHE_DIR, { recursive: true })
}

/**
 * Remove cache entry (audio + metadata).
 * @param {string} basePath
 */
async function removeCacheEntry(basePath) {
  const audioPath = `${basePath}.bin`
  const metaPath = `${basePath}.json`
  await Promise.allSettled([
    fs.promises.unlink(audioPath),
    fs.promises.unlink(metaPath),
  ])
}

/**
 * Check if cached file is still valid.
 * @param {string} audioPath
 */
async function getCacheStatus(audioPath) {
  try {
    const stat = await fs.promises.stat(audioPath)
    if (
      AUDIO_CACHE_TTL_MS > 0 &&
      Date.now() - stat.mtimeMs > AUDIO_CACHE_TTL_MS
    ) {
      return { valid: false, reason: 'expired' }
    }
    return { valid: true }
  } catch {
    return { valid: false, reason: 'missing' }
  }
}

/**
 * Load cache metadata if present.
 * @param {string} metaPath
 */
async function readCacheMetadata(metaPath) {
  try {
    const raw = await fs.promises.readFile(metaPath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * Persist cache metadata.
 * @param {string} metaPath
 * @param {Record<string, any>} metadata
 */
async function writeCacheMetadata(metaPath, metadata) {
  await fs.promises.writeFile(metaPath, JSON.stringify(metadata), 'utf8')
}

/**
 * Enforce approximate cache size limit by removing oldest entries first.
 */
async function enforceCacheSizeLimit() {
  if (!AUDIO_CACHE_MAX_BYTES) return
  let entries
  try {
    entries = await fs.promises.readdir(AUDIO_CACHE_DIR)
  } catch {
    return
  }

  const audioEntries = []
  for (const entry of entries) {
    if (!entry.endsWith('.bin')) continue
    const fullPath = path.join(AUDIO_CACHE_DIR, entry)
    try {
      const stat = await fs.promises.stat(fullPath)
      audioEntries.push({
        base: fullPath.slice(0, -4),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      })
    } catch {
      // ignore
    }
  }

  audioEntries.sort((a, b) => a.mtimeMs - b.mtimeMs)
  let totalSize = audioEntries.reduce((acc, item) => acc + item.size, 0)

  while (totalSize > AUDIO_CACHE_MAX_BYTES && audioEntries.length) {
    const entry = audioEntries.shift()
    if (!entry) break
    await removeCacheEntry(entry.base)
    totalSize -= entry.size
  }
}

/**
 * Get proxied IP for upstream requests.
 * @param {import('express').Request} req
 */
function resolveClientIp(req) {
  const forwarded =
    req.headers['x-forwarded-for'] ||
    req.headers['x-real-ip'] ||
    req.ip ||
    ''
  let ip = Array.isArray(forwarded) ? forwarded[0] : String(forwarded)
  if (!ip) return req.ip
  if (ip.includes(',')) {
    ip = ip.split(',')[0].trim()
  }
  if (ip.startsWith('::ffff:')) {
    return ip.slice(7)
  }
  if (ip === '::1') {
    return global.cnIp
  }
  return ip
}

/**
 * Proxy request helper with IP injection.
 * @param {import('express').Request} req
 */
function createRequestWithIp(req) {
  return (...params) => {
    const args = [...params]
    args[3] = {
      ...args[3],
      ip: resolveClientIp(req),
    }
    return request(...args)
  }
}

/**
 * Stream cached file to response.
 */
function streamCachedAudio(res, cachePath, metadata, cacheHit) {
  if (metadata?.contentType) {
    res.setHeader('Content-Type', metadata.contentType)
  }
  if (metadata?.contentLength) {
    res.setHeader('Content-Length', metadata.contentLength)
  }
  if (metadata?.originalFilename) {
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${metadata.originalFilename}"`,
    )
  }
  res.setHeader('X-Cache-Hit', cacheHit ? '1' : '0')
  const readStream = fs.createReadStream(cachePath)
  readStream.on('error', (err) => {
    console.error('Cache stream error', err)
    if (!res.headersSent) {
      res.status(500).json({ code: 500, msg: 'Cache read error' })
    } else {
      res.destroy(err)
    }
  })
  readStream.pipe(res)
}

/**
 * Download remote audio and cache to disk.
 */
async function downloadAndCacheAudio(cacheBasePath, url, options = {}) {
  if (inflightDownloads.has(cacheBasePath)) {
    return inflightDownloads.get(cacheBasePath)
  }

  const { headers = {}, metadata: extraMetadata = {} } = options

  const promise = (async () => {
    await ensureCacheDir()
    const tempPath = `${cacheBasePath}.tmp`
    const cachePath = `${cacheBasePath}.bin`
    const metaPath = `${cacheBasePath}.json`
    const response = await axios.get(url, {
      responseType: 'stream',
      headers,
      timeout: 30000,
    })
    const writer = fs.createWriteStream(tempPath)
    await pipeline(response.data, writer)
    await fs.promises.rename(tempPath, cachePath)
    await writeCacheMetadata(metaPath, {
      contentType: response.headers['content-type'] || 'audio/mpeg',
      contentLength: response.headers['content-length'] || undefined,
      fetchedAt: Date.now(),
      sourceUrl: url,
      ...extraMetadata,
    })
    await enforceCacheSizeLimit()
    return cachePath
  })()
    .finally(() => {
      inflightDownloads.delete(cacheBasePath)
    })
  inflightDownloads.set(cacheBasePath, promise)
  return promise
}

/**
 * The version check result.
 * @readonly
 * @enum {number}
 */
const VERSION_CHECK_RESULT = {
  FAILED: -1,
  NOT_LATEST: 0,
  LATEST: 1,
}

/**
 * @typedef {{
 *   identifier?: string,
 *   route: string,
 *   module: any
 * }} ModuleDefinition
 */

/**
 * @typedef {{
 *   port?: number,
 *   host?: string,
 *   checkVersion?: boolean,
 *   moduleDefs?: ModuleDefinition[]
 * }} NcmApiOptions
 */

/**
 * @typedef {{
 *   status: VERSION_CHECK_RESULT,
 *   ourVersion?: string,
 *   npmVersion?: string,
 * }} VersionCheckResult
 */

/**
 * @typedef {{
 *  server?: import('http').Server,
 * }} ExpressExtension
 */

/**
 * Get the module definitions dynamically.
 *
 * @param {string} modulesPath The path to modules (JS).
 * @param {Record<string, string>} [specificRoute] The specific route of specific modules.
 * @param {boolean} [doRequire] If true, require() the module directly.
 * Otherwise, print out the module path. Default to true.
 * @returns {Promise<ModuleDefinition[]>} The module definitions.
 *
 * @example getModuleDefinitions("./module", {"album_new.js": "/album/create"})
 */
async function getModulesDefinitions(
  modulesPath,
  specificRoute,
  doRequire = true,
) {
  const files = await fs.promises.readdir(modulesPath)
  const parseRoute = (/** @type {string} */ fileName) =>
    specificRoute && fileName in specificRoute
      ? specificRoute[fileName]
      : `/${fileName.replace(/\.js$/i, '').replace(/_/g, '/')}`

  const modules = files
    .reverse()
    .filter((file) => file.endsWith('.js'))
    .map((file) => {
      const identifier = file.split('.').shift()
      const route = parseRoute(file)
      const modulePath = path.join(modulesPath, file)
      const module = doRequire ? require(modulePath) : modulePath

      return { identifier, route, module }
    })

  return modules
}

/**
 * Check if the version of this API is latest.
 *
 * @returns {Promise<VersionCheckResult>} If true, this API is up-to-date;
 * otherwise, this API should be upgraded and you would
 * need to notify users to upgrade it manually.
 */
async function checkVersion() {
  return new Promise((resolve) => {
    exec('npm info NeteaseCloudMusicApi version', (err, stdout) => {
      if (!err) {
        let version = stdout.trim()

        /**
         * @param {VERSION_CHECK_RESULT} status
         */
        const resolveStatus = (status) =>
          resolve({
            status,
            ourVersion: packageJSON.version,
            npmVersion: version,
          })

        resolveStatus(
          packageJSON.version < version
            ? VERSION_CHECK_RESULT.NOT_LATEST
            : VERSION_CHECK_RESULT.LATEST,
        )
      } else {
        resolve({
          status: VERSION_CHECK_RESULT.FAILED,
        })
      }
    })
  })
}

/**
 * Construct the server of NCM API.
 *
 * @param {ModuleDefinition[]} [moduleDefs] Customized module definitions [advanced]
 * @returns {Promise<import("express").Express>} The server instance.
 */
async function consturctServer(moduleDefs) {
  const app = express()
  const { CORS_ALLOW_ORIGIN } = process.env
  app.set('trust proxy', true)

  /**
   * Serving static files
   */
  app.use(express.static(path.join(__dirname, 'public')))
  /**
   * CORS & Preflight request
   */
  app.use((req, res, next) => {
    if (req.path !== '/' && !req.path.includes('.')) {
      res.set({
        'Access-Control-Allow-Credentials': true,
        'Access-Control-Allow-Origin':
          CORS_ALLOW_ORIGIN || req.headers.origin || '*',
        'Access-Control-Allow-Headers': 'X-Requested-With,Content-Type',
        'Access-Control-Allow-Methods': 'PUT,POST,GET,DELETE,OPTIONS',
        'Content-Type': 'application/json; charset=utf-8',
      })
    }
    req.method === 'OPTIONS' ? res.status(204).end() : next()
  })

  /**
   * Cookie Parser
   */
  app.use((req, _, next) => {
    req.cookies = {}
    //;(req.headers.cookie || '').split(/\s*;\s*/).forEach((pair) => { //  Polynomial regular expression //
    ;(req.headers.cookie || '').split(/;\s+|(?<!\s)\s+$/g).forEach((pair) => {
      let crack = pair.indexOf('=')
      if (crack < 1 || crack == pair.length - 1) return
      req.cookies[decode(pair.slice(0, crack)).trim()] = decode(
        pair.slice(crack + 1),
      ).trim()
    })
    next()
  })

  /**
   * Body Parser and File Upload
   */
  app.use(express.json({ limit: '50mb' }))
  app.use(express.urlencoded({ extended: false, limit: '50mb' }))

  app.use(fileUpload())

  /**
   * Cache
   */
  app.use(cache('2 minutes', (_, res) => res.statusCode === 200))

  /**
   * Audio cache proxy
   */
  app.get('/custom/audio/:id', async (req, res) => {
    const { id } = req.params
    const { br, level } = req.query

    if (!id) {
      res.status(400).json({ code: 400, msg: 'Missing song id' })
      return
    }

    const bitrate = br ? String(br) : undefined
    const cacheKey = `${id}_${bitrate || level || 'default'}`
    const cacheBasePath = path.join(AUDIO_CACHE_DIR, cacheKey)
    const cacheAudioPath = `${cacheBasePath}.bin`
    const cacheMetaPath = `${cacheBasePath}.json`

    try {
      const cacheStatus = await getCacheStatus(cacheAudioPath)
      if (cacheStatus.valid) {
        const metadata = await readCacheMetadata(cacheMetaPath)
        streamCachedAudio(res, cacheAudioPath, metadata, true)
        return
      }
      if (cacheStatus.reason === 'expired') {
        await removeCacheEntry(cacheBasePath)
      }

      const moduleResponse = await songUrlModule(
        {
          id,
          br: bitrate,
          level,
          cookie: req.cookies,
        },
        createRequestWithIp(req),
      )

      if (moduleResponse.status !== 200) {
        res
          .status(moduleResponse.status)
          .send(moduleResponse.body || { code: moduleResponse.status })
        return
      }

      const data = moduleResponse.body?.data
      if (!Array.isArray(data) || !data.length) {
        res.status(404).json({ code: 404, msg: 'Song url not found' })
        return
      }

      const target = data.find(
        (item) => String(item.id) === String(id),
      ) || data[0]

      if (!target?.url) {
        res.status(403).json({
          code: 403,
          msg: 'No playable URL returned (maybe VIP / region restricted)',
        })
        return
      }

      const downloadHeaders = {
        Referer: 'https://music.163.com',
      }

      const extraMeta = {}
      if (target?.type) {
        extraMeta.originalFilename = `${id}.${target.type.toLowerCase()}`
      }

      await downloadAndCacheAudio(cacheBasePath, target.url, {
        headers: downloadHeaders,
        metadata: extraMeta,
      })
      const metadata = await readCacheMetadata(cacheMetaPath)
      streamCachedAudio(res, cacheAudioPath, metadata, false)
    } catch (error) {
      console.error('Audio proxy error', error)
      res.status(500).json({ code: 500, msg: 'Audio proxy failed' })
    }
  })

  /**
   * Special Routers
   */
  const special = {
    'daily_signin.js': '/daily_signin',
    'fm_trash.js': '/fm_trash',
    'personal_fm.js': '/personal_fm',
  }

  /**
   * Load every modules in this directory
   */
  const moduleDefinitions =
    moduleDefs ||
    (await getModulesDefinitions(path.join(__dirname, 'module'), special))

  for (const moduleDef of moduleDefinitions) {
    // Register the route.
    app.use(moduleDef.route, async (req, res) => {
      ;[req.query, req.body].forEach((item) => {
        if (typeof item.cookie === 'string') {
          item.cookie = cookieToJson(decode(item.cookie))
        }
      })

      let query = Object.assign(
        {},
        { cookie: req.cookies },
        req.query,
        req.body,
        req.files,
      )

      try {
        const moduleResponse = await moduleDef.module(query, (...params) => {
          // 参数注入客户端IP
          const obj = [...params]
          let ip = req.ip

          if (ip.substr(0, 7) == '::ffff:') {
            ip = ip.substr(7)
          }
          if (ip == '::1') {
            ip = global.cnIp
          }
          // console.log(ip)
          obj[3] = {
            ...obj[3],
            ip,
          }
          return request(...obj)
        })
        console.log('[OK]', decode(req.originalUrl))

        const cookies = moduleResponse.cookie
        if (!query.noCookie) {
          if (Array.isArray(cookies) && cookies.length > 0) {
            if (req.protocol === 'https') {
              // Try to fix CORS SameSite Problem
              res.append(
                'Set-Cookie',
                cookies.map((cookie) => {
                  return cookie + '; SameSite=None; Secure'
                }),
              )
            } else {
              res.append('Set-Cookie', cookies)
            }
          }
        }
        res.status(moduleResponse.status).send(moduleResponse.body)
      } catch (/** @type {*} */ moduleResponse) {
        console.log('[ERR]', decode(req.originalUrl), {
          status: moduleResponse.status,
          body: moduleResponse.body,
        })
        if (!moduleResponse.body) {
          res.status(404).send({
            code: 404,
            data: null,
            msg: 'Not Found',
          })
          return
        }
        if (moduleResponse.body.code == '301')
          moduleResponse.body.msg = '需要登录'
        if (!query.noCookie) {
          res.append('Set-Cookie', moduleResponse.cookie)
        }

        res.status(moduleResponse.status).send(moduleResponse.body)
      }
    })
  }

  // const biliApiConfigs = [
  //   {
  //     path: '/search',
  //     url: 'https://api.bilibili.com/x/web-interface/wbi/search/type',
  //     useWbi: true,
  //     defaultParams: {
  //       search_type: 'video',
  //       page: 1,
  //       pagesize: 20,
  //     },
  //     requiredParams: ['keyword'],
  //     beforeRequest: (params, req) => {
  //       req.headers.cookie =
  //         "buvid3=9B0B33C1-4830-BC70-2864-77636393B9B971648infoc; b_nut=1724315771; _uuid=75D38359-51EF-EEC10-8424-C4EDF51957D772498infoc; buvid4=0B210FD9-0507-6CBE-DA1A-4A0F4BE88B1773106-024082208-f94sXvcWbd57LLUgCjMKPg%3D%3D; rpdid=|(YuuR|kJlY0J'u~kRJul~~J; DedeUserID=47099129; DedeUserID__ckMd5=4140f5f67a35835c; header_theme_version=CLOSE; enable_web_push=DISABLE; home_feed_column=5; SESSDATA=b8861b34%2C1750039161%2Cc41c1%2Ac1CjAUufRpGk7V2H-qkC58yBYl8jOq56zRIKe3xRZlbCrUXJfI4hn1cMcKNa0UXVeYPuUSVmExc1dvbGg2UURSMzFrTFFackgxUXNSVHFNM0VXdlpSMVJrV1lxWTV3QTFPYlJwMFNpQllVdXF3c0kyTWNGbFc1ckpobWg5RmVqLUJBb3FqX1NRUXVRIIEC; bili_jct=f6a49c97e21c218abe5283f0183c95e7; CURRENT_QUALITY=80; fingerprint=75fa41130e45af4d4dea36f0d4d597e6; buvid_fp_plain=undefined; buvid_fp=75fa41130e45af4d4dea36f0d4d597e6; enable_feed_channel=ENABLE; CURRENT_FNVAL=4048; b_lsid=F3B83328_195D5211B7A; bili_ticket=eyJhbGciOiJIUzI1NiIsImtpZCI6InMwMyIsInR5cCI6IkpXVCJ9.eyJleHAiOjE3NDMyOTY2NzMsImlhdCI6MTc0MzAzNzQxMywicGx0IjotMX0.uLeoTAK8QFvnRUu3c6-EDJ1ynPsjAhEYmx5m3OA7z8k; bili_ticket_expires=1743296613; browser_resolution=1994-1235; bp_t_offset_47099129=1048833625023315968"
  //       console.log(`搜索B站内容: ${params.keyword}`)
  //       return params
  //     },
  //   },
  //   {
  //     path: '/video/detail',
  //     url: 'https://api.bilibili.com/x/web-interface/wbi/view',
  //     useWbi: true,
  //     requiredParams: ['bvid'],
  //     beforeRequest: (params) => {
  //       console.log(`获取B站视频详情: ${params.bvid}`)
  //       return params
  //     },
  //   },
  //   {
  //     path: '/playurl',
  //     url: 'https://api.bilibili.com/x/player/wbi/playurl',
  //     useWbi: true,
  //     defaultParams: {
  //       qn: 0,
  //       fnval: 80,
  //       fnver: 0,
  //       fourk: 1,
  //     },
  //     requiredParams: ['bvid', 'cid'],
  //     beforeRequest: (params) => {
  //       console.log(`获取B站视频播放地址: ${params.bvid} ${params.cid}`)
  //       return params
  //     },
  //   },
  //   {
  //     path: '/hot',
  //     url: 'https://api.bilibili.com/x/web-interface/popular',
  //     defaultParams: { ps: 20, pn: 1 },
  //   },
  //   {
  //     path: '/related',
  //     url: 'https://api.bilibili.com/x/web-interface/archive/related',
  //     requiredParams: ['bvid'],
  //   },
  //   {
  //     path: '/user/info',
  //     url: 'https://api.bilibili.com/x/space/acc/info',
  //     requiredParams: ['mid'],
  //   },
  //   {
  //     path: '/user/videos',
  //     url: 'https://api.bilibili.com/x/space/wbi/arc/search',
  //     useWbi: true,
  //     defaultParams: { ps: 30, pn: 1 },
  //     requiredParams: ['mid'],
  //   },
  // ]

  // 使用注册器注册B站API
  //
  // stream-proxy API用法:
  // GET /bilibili/stream-proxy?url=视频直链地址
  //
  // 该接口将流式返回B站视频内容，保持 Referer 为 https://www.bilibili.com/
  // 流代理接口实现在 util/biliApiHandler.js 中，可用于视频播放
  // 示例用法见 examples/bilibili_stream_proxy.js
  registerBiliApis(app, biliApiConfigs)
  return app
}

/**
 * Serve the NCM API.
 * @param {NcmApiOptions} options
 * @returns {Promise<import('express').Express & ExpressExtension>}
 */
async function serveNcmApi(options) {
  const port = Number(options.port || process.env.PORT || '3000')
  const host = options.host || process.env.HOST || ''

  const checkVersionSubmission =
    options.checkVersion &&
    checkVersion().then(({ npmVersion, ourVersion, status }) => {
      if (status == VERSION_CHECK_RESULT.NOT_LATEST) {
        console.log(
          `最新版本: ${npmVersion}, 当前版本: ${ourVersion}, 请及时更新`,
        )
      }
    })
  const constructServerSubmission = consturctServer(options.moduleDefs)

  const [_, app] = await Promise.all([
    checkVersionSubmission,
    constructServerSubmission,
  ])

  /** @type {import('express').Express & ExpressExtension} */
  const appExt = app
  appExt.server = app.listen(port, host, () => {
    console.log(`server running @ http://${host ? host : 'localhost'}:${port}`)
  })

  return appExt
}
module.exports = {
  serveNcmApi,
  getModulesDefinitions,
}
