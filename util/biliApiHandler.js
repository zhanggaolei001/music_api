const { biliRequest, cache } = require('./biliRequest')
const axios = require('axios')
const http = require('http')
const https = require('https')
const { URL } = require('url')
const fs = require('fs')
const path = require('path')

// Cookie缓存路径
const COOKIE_CACHE_PATH = path.join(__dirname, '../cache/bilibili_cookies.json')
// 默认Cookie路径 - 用户可以在这里配置自己的Cookie
const DEFAULT_COOKIE_PATH = path.join(
  __dirname,
  '../config/bilibili_cookie.txt',
)

/**
 * 加载缓存的Cookie
 * @returns {string|null} 缓存的Cookie字符串或null
 */
function loadCookies() {
  try {
    if (fs.existsSync(COOKIE_CACHE_PATH)) {
      const data = fs.readFileSync(COOKIE_CACHE_PATH, 'utf8')
      const cookieData = JSON.parse(data)

      // 检查Cookie是否过期
      if (cookieData.expiresAt && new Date(cookieData.expiresAt) > new Date()) {
        console.log('使用缓存的B站cookies')
        return cookieData.cookieString
      }
      console.log('缓存的B站cookies已过期')
    }
  } catch (error) {
    console.error('加载B站cookies缓存失败:', error)
  }
  return null
}

/**
 * 保存Cookie到缓存
 * @param {string} cookieString Cookie字符串
 * @param {number} [expiresInDays=7] Cookie过期天数
 */
function saveCookies(cookieString, expiresInDays = 7) {
  try {
    // 创建缓存目录（如果不存在）
    const cacheDir = path.dirname(COOKIE_CACHE_PATH)
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true })
    }

    // 设置过期时间
    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + expiresInDays)

    // 保存Cookie数据
    const cookieData = {
      cookieString,
      expiresAt: expiresAt.toISOString(),
    }

    fs.writeFileSync(COOKIE_CACHE_PATH, JSON.stringify(cookieData), 'utf8')
    console.log('B站cookies已缓存')
  } catch (error) {
    console.error('保存B站cookies失败:', error)
  }
}

/**
 * 从配置文件加载默认Cookie
 * @returns {string} 配置的Cookie字符串，如果不存在则返回空字符串
 */
function loadDefaultCookieFromConfig() {
  try {
    if (fs.existsSync(DEFAULT_COOKIE_PATH)) {
      return fs.readFileSync(DEFAULT_COOKIE_PATH, 'utf8').trim()
    }
  } catch (error) {
    console.error('从配置加载默认Cookie失败:', error)
  }
  return ''
}

/**
 * 从B站首页获取基础Cookie（不登录）
 * @returns {Promise<string>} Cookie字符串
 */
async function fetchBasicCookies() {
  try {
    const response = await axios.get('https://www.bilibili.com', {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      },
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
    })

    const cookies = response.headers['set-cookie'] || []
    if (cookies.length) {
      const cookieString = cookies
        .map((cookie) => cookie.split(';')[0])
        .join('; ')

      console.log('成功获取基础Cookie')
      return cookieString
    }

    return ''
  } catch (error) {
    console.error('获取基础Cookie失败:', error.message)
    return ''
  }
}

/**
 * 获取Bilibili Cookies
 * 优先级: 1.缓存 2.配置文件 3.通过请求获取基础Cookie
 * @returns {Promise<string>} Cookie字符串
 */
async function getBilibiliCookies() {
  // 1. 尝试从缓存加载
  const cachedCookies = loadCookies()
  if (cachedCookies) {
    return cachedCookies
  }

  // 2. 尝试从配置文件加载
  const configCookies = loadDefaultCookieFromConfig()
  if (configCookies) {
    console.log('使用配置文件中的Cookie')
    saveCookies(configCookies) // 保存到缓存
    return configCookies
  }

  // 3. 获取基础Cookie
  const basicCookies = await fetchBasicCookies()
  if (basicCookies) {
    saveCookies(basicCookies)
    return basicCookies
  }

  return ''
}

// 默认Cookie字符串
let defaultCookieString = ''

// 初始化默认Cookie
async function initDefaultCookie() {
  defaultCookieString = await getBilibiliCookies()
  console.log('defaultCookieString', defaultCookieString)
  if (defaultCookieString) {
    console.log('B站默认cookie已初始化')
  } else {
    console.warn('未能初始化B站默认cookie，API请求可能受到限制')
  }
}

// 获取Cookie（优先使用请求中的Cookie，否则使用默认Cookie）
function getCookie(reqCookie) {
  return reqCookie || defaultCookieString
}

/**
 * 更新Cookie
 * @param {string} cookieString 新的Cookie字符串
 * @returns {boolean} 是否更新成功
 */
function updateCookie(cookieString) {
  if (!cookieString || typeof cookieString !== 'string') {
    return false
  }

  defaultCookieString = cookieString
  saveCookies(cookieString)
  return true
}

/**
 * B站API配置项
 * @typedef {Object} BiliApiConfig
 * @property {string} path - API路径，如 '/search'
 * @property {string} url - B站API完整URL，如 'https://api.bilibili.com/x/web-interface/wbi/search/type'
 * @property {boolean} [useWbi=false] - 是否使用WBI签名
 * @property {Object} [defaultParams={}] - 默认参数
 * @property {Array<string>} [requiredParams=[]] - 必需参数列表
 * @property {string} [method='GET'] - 请求方法
 * @property {function} [beforeRequest] - 请求前处理函数，返回处理后的参数
 * @property {function} [afterResponse] - 响应后处理函数，返回处理后的响应
 */

/**
 * 创建流式代理请求
 * @param {string} url - 要代理的URL
 * @param {Object} headers - 要使用的请求头
 * @param {import('express').Request} req - Express请求对象
 * @param {import('express').Response} res - Express响应对象
 */
async function createStreamProxy(url, headers, req, res) {
  try {
    // 选择合适的HTTP客户端
    const httpClient = url.startsWith('https') ? https : http
    const parsedUrl = new URL(url)

    // 设置代理请求选项
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (url.startsWith('https') ? 443 : 80),
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      method: 'GET',
      headers: {
        ...headers,
        Referer: 'https://www.bilibili.com/',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      },
    }

    // 创建代理请求
    const proxyReq = httpClient.request(options, (proxyRes) => {
      // 把源站响应头复制到我们的响应
      res.writeHead(proxyRes.statusCode, proxyRes.headers)

      // 直接管道连接响应流
      proxyRes.pipe(res)
    })

    // 处理错误
    proxyReq.on('error', (err) => {
      console.error('代理请求错误:', err)
      if (!res.headersSent) {
        res.status(500).json({
          code: 500,
          message: '代理请求失败',
          error: err.message,
        })
      }
    })

    // 结束请求
    proxyReq.end()
  } catch (error) {
    console.error('创建代理流失败:', error)
    if (!res.headersSent) {
      res.status(500).json({
        code: 500,
        message: '创建代理流失败',
        error: error.message,
      })
    }
  }
}

/**
 * 注册B站API路由
 * @param {import('express').Express} app - Express应用实例
 * @param {Array<BiliApiConfig>} apiConfigs - API配置列表
 * @param {Object} [options] - 选项
 * @param {string} [options.prefix='/bilibili'] - API路径前缀
 */
function registerBiliApis(app, apiConfigs, options = {}) {
  const prefix = options.prefix || '/bilibili'

  // 初始化默认Cookie
  initDefaultCookie()

  // 注册API路由
  apiConfigs.forEach((config) => {
    const {
      path,
      url,
      useWbi = false,
      defaultParams = {},
      requiredParams = [],
      method = 'GET',
      beforeRequest,
      afterResponse,
    } = config

    // 路由处理函数
    const routeHandler = async (req, res) => {
      try {
        // 合并请求参数
        let params = { ...defaultParams }

        // 获取查询参数
        if (method.toUpperCase() === 'GET') {
          params = { ...params, ...req.query }
        } else {
          params = { ...params, ...req.body }
        }

        // 验证必需参数
        for (const param of requiredParams) {
          if (!params[param]) {
            return res.status(400).json({
              code: 400,
              message: `缺少必需参数: ${param}`,
            })
          }
        }

        // 请求前处理
        if (typeof beforeRequest === 'function') {
          params = await beforeRequest(params, req)
          // 如果beforeRequest返回false，则中断请求
          if (params === false) {
            return
          }
        }

        // 获取Cookie
        const cookie = getCookie(req.headers.cookie)

        // 发送请求
        const result = await biliRequest({
          url,
          params,
          useWbi,
          method,
          cookie: cookie,
        })

        // 响应后处理
        if (typeof afterResponse === 'function') {
          const processedResult = await afterResponse(result, req, res)
          if (processedResult !== undefined) {
            return res.json(processedResult)
          }
        }

        // 返回结果
        res.json(result)
      } catch (error) {
        console.error(`${path}请求失败:`, error)
        res.status(500).json({
          code: 500,
          message: '服务器内部错误',
          error:
            process.env.NODE_ENV === 'development' ? error.message : undefined,
        })
      }
    }

    // 注册路由
    const routePath = `${prefix}${path}`
    if (method.toUpperCase() === 'GET') {
      app.get(routePath, routeHandler)
    } else if (method.toUpperCase() === 'POST') {
      app.post(routePath, routeHandler)
    } else {
      app.all(routePath, routeHandler)
    }

    console.log(`已注册B站API路由: ${method} ${routePath} -> ${url}`)
  })

  // 注册流代理路由
  app.get(`${prefix}/stream-proxy`, async (req, res) => {
    const { url } = req.query

    if (!url) {
      return res.status(400).json({
        code: 400,
        message: '缺少必需参数: url',
      })
    }

    try {
      // 设置自定义请求头
      const headers = {
        Referer: 'https://www.bilibili.com/',
      }

      // 从原始请求传递一些必要的头部
      if (req.headers.range) {
        headers.range = req.headers.range
      }

      // 获取Cookie
      const cookie = getCookie(req.headers.cookie)
      if (cookie) {
        headers.cookie = cookie
      }

      console.log(`代理流请求: ${url}`)
      await createStreamProxy(url, headers, req, res)
    } catch (error) {
      console.error('代理流请求失败:', error)
      if (!res.headersSent) {
        res.status(500).json({
          code: 500,
          message: '代理流请求失败',
          error:
            process.env.NODE_ENV === 'development' ? error.message : undefined,
        })
      }
    }
  })

  console.log(`已注册B站流媒体代理路由: GET ${prefix}/stream-proxy`)

  // 注册更新Cookie路由 - 允许用户提供自己的Cookie
  app.post(`${prefix}/update-cookie`, (req, res) => {
    const { cookie } = req.body

    if (!cookie) {
      return res.status(400).json({
        code: 400,
        message: '缺少cookie参数',
      })
    }

    if (updateCookie(cookie)) {
      // 创建配置目录并保存用户提供的cookie到配置文件
      try {
        const configDir = path.dirname(DEFAULT_COOKIE_PATH)
        if (!fs.existsSync(configDir)) {
          fs.mkdirSync(configDir, { recursive: true })
        }
        fs.writeFileSync(DEFAULT_COOKIE_PATH, cookie, 'utf8')
      } catch (error) {
        console.error('保存Cookie到配置文件失败:', error)
      }

      res.json({ code: 0, message: 'Cookie已更新' })
    } else {
      res.status(400).json({ code: 400, message: 'Cookie格式不正确' })
    }
  })

  console.log(`已注册B站Cookie更新路由: POST ${prefix}/update-cookie`)

  // 刷新Cookie - 尝试从各个来源重新获取Cookie
  app.get(`${prefix}/refresh-cookie`, async (req, res) => {
    try {
      defaultCookieString = await getBilibiliCookies()
      res.json({ code: 0, message: 'Cookie已刷新' })
    } catch (error) {
      res.status(500).json({
        code: 500,
        message: '刷新Cookie失败',
        error:
          process.env.NODE_ENV === 'development' ? error.message : undefined,
      })
    }
  })

  console.log(`已注册B站Cookie刷新路由: GET ${prefix}/refresh-cookie`)

  // 注册清除缓存路由
  app.get(`${prefix}/clear-cache`, (req, res) => {
    cache.buvid = ''
    cache.wbiKeys = null
    cache.lastWbiKeysFetchTime = 0

    // 也清除Cookie缓存
    if (fs.existsSync(COOKIE_CACHE_PATH)) {
      fs.unlinkSync(COOKIE_CACHE_PATH)
    }

    res.json({ code: 0, message: '缓存已清除' })
  })

  console.log(`已注册B站API缓存清理路由: GET ${prefix}/clear-cache`)
}

module.exports = {
  registerBiliApis,
  createStreamProxy,
  getBilibiliCookies,
  updateCookie,
}
