const CryptoJS = require('crypto-js')
const md5 = require('md5')
const axios = require('axios')

const cryptoMd5 = (str) => {
  return CryptoJS.MD5(str).toString()
}

const appSign = (params, appkey, appsec) => {
  params.appkey = appkey
  const searchParams = new URLSearchParams(params)
  searchParams.sort()
  return cryptoMd5(searchParams.toString() + appsec)
}

const mixinKeyEncTab = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
]

// 对 imgKey 和 subKey 进行字符顺序打乱编码
const getMixinKey = (orig) =>
  mixinKeyEncTab
    .map((n) => orig[n])
    .join('')
    .slice(0, 32)

// 为请求参数进行 wbi 签名
function encWbi(params, img_key, sub_key) {
  const mixin_key = getMixinKey(img_key + sub_key),
    curr_time = Math.round(Date.now() / 1000),
    chr_filter = /[!'()*]/g

  Object.assign(params, { wts: curr_time }) // 添加 wts 字段
  // 按照 key 重排参数
  const query = Object.keys(params)
    .sort()
    .map((key) => {
      // 过滤 value 中的 "!'()*" 字符
      const value = params[key].toString().replace(chr_filter, '')
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
    })
    .join('&')

  const wbi_sign = md5(query + mixin_key) // 计算 w_rid

  return query + '&w_rid=' + wbi_sign
}

// 缓存机制
const cache = {
  buvid: '',
  wbiKeys: null,
  lastWbiKeysFetchTime: 0,
}

// 获取最新的 img_key 和 sub_key
const getWbiKeys = async () => {
  // 如果缓存的wbi keys存在且未过期（30分钟内有效），直接返回缓存
  const now = Date.now()
  if (cache.wbiKeys && now - cache.lastWbiKeysFetchTime < 30 * 60 * 1000) {
    return cache.wbiKeys
  }

  try {
    const res = await axios.get(
      'https://api.bilibili.com/x/web-interface/nav',
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3',
          Referer: 'https://www.bilibili.com/',
        },
      },
    )

    const {
      wbi_img: { img_url, sub_url },
    } = res.data.data

    cache.wbiKeys = {
      img_key: img_url.slice(
        img_url.lastIndexOf('/') + 1,
        img_url.lastIndexOf('.'),
      ),
      sub_key: sub_url.slice(
        sub_url.lastIndexOf('/') + 1,
        sub_url.lastIndexOf('.'),
      ),
    }
    cache.lastWbiKeysFetchTime = now

    return cache.wbiKeys
  } catch (error) {
    console.error('获取WBI Keys失败:', error)
    throw error
  }
}

async function main() {
  const web_keys = await getWbiKeys()
  const params = { keyword: '周杰伦' },
    img_key = web_keys.img_key,
    sub_key = web_keys.sub_key
  const params1 = encWbi(
    { keyword: '贫道活腻了', search_type: 'video' },
    img_key,
    sub_key,
  )
  // https://api.bilibili.com/x/web-interface/wbi/search/type

  try {
    // 获取buvid
    if (!cache.buvid) {
      const buvidRes = await axios.get(
        'https://api.bilibili.com/x/web-frontend/getbuvid',
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3',
            Referer: 'https://www.bilibili.com/',
          },
        },
      )
      cache.buvid = buvidRes.data.data.buvid
    }

    // 使用缓存的buvid
    const res1 = await axios.get(
      `https://api.bilibili.com/x/web-interface/wbi/search/type?${params1}`,
      {
        headers: {
          Cookie: `buvid3=${cache.buvid}`,
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3',
          Referer: 'https://www.bilibili.com/',
        },
      },
    )

    console.log(JSON.stringify(res1.data))
  } catch (error) {
    console.error('请求失败:', error)
  }
}

/**
 * 通用B站API请求函数
 * @param {Object} options - 请求配置
 * @param {string} options.url - 请求URL
 * @param {Object} options.params - 请求参数
 * @param {boolean} options.useWbi - 是否使用WBI签名 (默认: false)
 * @param {string} options.method - 请求方法 (默认: GET)
 * @param {Object} options.headers - 额外的请求头
 * @param {string} options.cookie - 自定义Cookie
 * @param {boolean} options.needBuvid - 是否需要获取buvid (默认: true)
 * @param {boolean} options.useCachedBuvid - 是否使用缓存的buvid (默认: true)
 * @returns {Promise<Object>} 请求结果
 */
async function biliRequest(options) {
  const {
    url,
    params = {},
    useWbi = false,
    method = 'GET',
    headers = {},
    cookie = '',
    needBuvid = true,
    useCachedBuvid = true,
  } = options

  // 默认请求头
  const defaultHeaders = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3',
    Referer: 'https://www.bilibili.com/',
  }

  // 合并请求头
  let requestHeaders = { ...defaultHeaders, ...headers }

  // 获取buvid
  let buvid = ''
  if (needBuvid) {
    try {
      // 使用缓存的buvid或重新获取
      if (useCachedBuvid && cache.buvid) {
        buvid = cache.buvid
      } else {
        const buvidRes = await axios.get(
          'https://api.bilibili.com/x/web-frontend/getbuvid',
          {
            headers: defaultHeaders,
          },
        )
        buvid = buvidRes.data.data.buvid
        // 更新缓存
        cache.buvid = buvid
      }

      // 添加buvid到Cookie
      if (buvid) {
        const cookieValue = cookie
          ? `${cookie}; buvid3=${buvid}`
          : `buvid3=${buvid}`
        requestHeaders['Cookie'] = cookieValue
      } else if (cookie) {
        requestHeaders['Cookie'] = cookie
      }
    } catch (error) {
      console.error('获取buvid失败:', error)
      if (cookie) {
        requestHeaders['Cookie'] = cookie
      }
    }
  } else if (cookie) {
    requestHeaders['Cookie'] = cookie
  }

  // 构建URL和参数
  let requestUrl = url
  let queryParams = {}

  if (useWbi) {
    // 使用WBI签名
    try {
      const wbiKeys = await getWbiKeys()
      const wbiQueryString = encWbi(params, wbiKeys.img_key, wbiKeys.sub_key)

      // 将wbi查询字符串转换为对象
      const urlSearchParams = new URLSearchParams(wbiQueryString)
      for (const [key, value] of urlSearchParams.entries()) {
        queryParams[key] = value
      }
    } catch (error) {
      console.error('WBI签名失败:', error)
      return { code: -1, message: 'WBI签名失败', error }
    }
  } else {
    // 直接使用传入的参数
    queryParams = { ...params }
  }

  // 发送请求
  try {
    const response = await axios({
      method,
      url: requestUrl,
      params: queryParams,
      headers: requestHeaders,
    })

    return response.data
  } catch (error) {
    console.error('请求失败:', error)
    return {
      code: -1,
      message: '请求失败',
      error: error.response
        ? {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data,
        }
        : error.message,
    }
  }
}

module.exports = {
  appSign,
  getWbiKeys,
  main,
  biliRequest,
  // 导出缓存对象，便于外部操作
  cache,
}
