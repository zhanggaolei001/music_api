const biliApiConfigs = [
  {
    path: '/search',
    url: 'https://api.bilibili.com/x/web-interface/wbi/search/type',
    useWbi: true,
    defaultParams: {
      search_type: 'video',
      page: 1,
      pagesize: 20,
    },
    requiredParams: ['keyword'],
    beforeRequest: (params, req) => {
      console.log(`搜索B站内容: ${params.keyword}`)
      return params
    },
  },
  {
    path: '/video/detail',
    url: 'https://api.bilibili.com/x/web-interface/wbi/view',
    useWbi: true,
    requiredParams: ['bvid'],
    beforeRequest: (params) => {
      console.log(`获取B站视频详情: ${params.bvid}`)
      return params
    },
  },
  {
    path: '/playurl',
    url: 'https://api.bilibili.com/x/player/wbi/playurl',
    useWbi: true,
    defaultParams: {
      qn: 0,
      fnval: 80,
      fnver: 0,
      fourk: 1,
    },
    requiredParams: ['bvid', 'cid'],
    beforeRequest: (params) => {
      console.log(`获取B站视频播放地址: ${params.bvid} ${params.cid}`)
      return params
    },
  },
]

module.exports = biliApiConfigs
