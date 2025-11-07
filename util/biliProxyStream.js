const express = require('express')
const { createProxyMiddleware } = require('http-proxy-middleware')
const fetch = require('node-fetch')
const httpProxy = require('http-proxy')
const stream = require('stream')
const proxy = require('express-http-proxy')

/**
 * 使用http-proxy-middleware库实现代理
 * @param {import('express').Express} app - Express应用实例
 * @param {string} path - 路由路径
 * @param {Object} options - 选项
 */
function setupProxyWithMiddleware(
  app,
  path = '/proxy/middleware',
  options = {},
) {
  const prefix = options.prefix || '/bilibili'
  const routePath = `${prefix}${path}`

  // 创建代理中间件
  const proxyMiddleware = createProxyMiddleware({
    router: (req) => {
      // 从查询参数获取目标URL
      const targetUrl = decodeURIComponent(req.query.url)
      return targetUrl
    },
    changeOrigin: true,
    pathRewrite: () => '', // 重置路径
    onProxyReq: (proxyReq, req, res) => {
      // 添加必要的请求头
      proxyReq.setHeader('Referer', 'https://www.bilibili.com')
      proxyReq.setHeader('Origin', 'https://www.bilibili.com')
      proxyReq.setHeader('platform', 'html5')
      proxyReq.setHeader(
        'User-Agent',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      )
    },
    onProxyRes: (proxyRes, req, res) => {
      // 设置CORS头
      proxyRes.headers['Access-Control-Allow-Origin'] = '*'
      proxyRes.headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS'
      proxyRes.headers['Access-Control-Allow-Headers'] = 'Range'

      console.log(`代理成功: ${req.query.url} 状态码: ${proxyRes.statusCode}`)
    },
    onError: (err, req, res) => {
      console.error('代理错误:', err)
      res.status(500).json({
        code: 500,
        message: '代理请求失败',
        error: err.message,
      })
    },
    // 超时设置
    proxyTimeout: 60000,
    timeout: 60000,
  })

  app.get(
    routePath,
    (req, res, next) => {
      if (!req.query.url) {
        return res.status(400).json({
          code: 400,
          message: '缺少必需参数: url',
        })
      }

      next()
    },
    proxyMiddleware,
  )

  console.log(
    `已注册B站流媒体代理路由(http-proxy-middleware): GET ${routePath}`,
  )
}

/**
 * 使用express-http-proxy库实现代理
 * @param {import('express').Express} app - Express应用实例
 * @param {string} path - 路由路径
 * @param {Object} options - 选项
 */
function setupExpressProxy(app, path = '/proxy/express', options = {}) {
  const prefix = options.prefix || '/bilibili'
  const routePath = `${prefix}${path}`

  app.get(
    routePath,
    (req, res, next) => {
      if (!req.query.url) {
        return res.status(400).json({
          code: 400,
          message: '缺少必需参数: url',
        })
      }

      next()
    },
    proxy(
      (req) => {
        // 从查询参数获取目标URL
        return decodeURIComponent(req.query.url)
      },
      {
        // 修改请求头
        proxyReqOptDecorator: (proxyReqOpts, srcReq) => {
          proxyReqOpts.headers['Referer'] = 'https://www.bilibili.com'
          proxyReqOpts.headers['Origin'] = 'https://www.bilibili.com'
          proxyReqOpts.headers['platform'] = 'html5'
          proxyReqOpts.headers['User-Agent'] =
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

          // 保留Range头（用于断点续传）
          if (srcReq.headers.range) {
            proxyReqOpts.headers['Range'] = srcReq.headers.range
          }

          return proxyReqOpts
        },
        // 修改响应头
        userResHeaderDecorator: (
          headers,
          userReq,
          userRes,
          proxyReq,
          proxyRes,
        ) => {
          headers['Access-Control-Allow-Origin'] = '*'
          headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS'
          headers['Access-Control-Allow-Headers'] = 'Range'
          return headers
        },
        // 处理超时
        timeout: 60000,
        // 处理错误
        proxyErrorHandler: (err, res, next) => {
          console.error('express-http-proxy错误:', err)
          if (!res.headersSent) {
            res.status(500).json({
              code: 500,
              message: '代理请求失败',
              error: err.message,
            })
          }
        },
      },
    ),
  )

  console.log(`已注册B站流媒体代理路由(express-http-proxy): GET ${routePath}`)
}

/**
 * 使用node-fetch库实现代理
 * @param {import('express').Express} app - Express应用实例
 * @param {string} path - 路由路径
 * @param {Object} options - 选项
 */
function setupFetchProxy(app, path = '/proxy/fetch', options = {}) {
  const prefix = options.prefix || '/bilibili'
  const routePath = `${prefix}${path}`

  app.get(routePath, async (req, res) => {
    const { url } = req.query

    if (!url) {
      return res.status(400).json({
        code: 400,
        message: '缺少必需参数: url',
      })
    }

    try {
      // 解码URL
      const decodedUrl = decodeURIComponent(url)

      // 设置请求头
      const headers = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://www.bilibili.com',
        Origin: 'https://www.bilibili.com',
        platform: 'html5',
      }

      // 传递Range头（如果存在）
      if (req.headers.range) {
        headers['Range'] = req.headers.range
      }

      console.log('发送fetch请求到B站:', decodedUrl)

      // 使用node-fetch发送请求
      const response = await fetch(decodedUrl, {
        method: 'GET',
        headers: headers,
        timeout: 60000, // 60秒超时
        redirect: 'follow', // 自动跟随重定向
      })

      // 检查响应状态
      if (!response.ok && response.status !== 206) {
        // 206是部分内容响应，是正常的
        throw new Error(`HTTP错误! 状态: ${response.status}`)
      }

      // 转发响应头
      for (const [key, value] of response.headers.entries()) {
        res.setHeader(key, value)
      }

      // 设置CORS头
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Range')

      // 设置响应状态码
      res.status(response.status)

      // 创建可读流并传输到响应
      const body = response.body
      body.pipe(res)

      console.log(
        `fetch代理成功: ${decodedUrl.substring(0, 50)}... 状态码: ${
          response.status
        }`,
      )
    } catch (error) {
      console.error('fetch代理错误:', error)

      // 如果已经发送了响应头，直接结束响应
      if (res.headersSent) {
        return res.end()
      }

      res.status(500).json({
        code: 500,
        message: '代理请求失败',
        error: error.message,
      })
    }
  })

  console.log(`已注册B站流媒体代理路由(node-fetch): GET ${routePath}`)
}

module.exports = {
  setupProxyWithMiddleware,
  setupExpressProxy,
  setupFetchProxy,
}
