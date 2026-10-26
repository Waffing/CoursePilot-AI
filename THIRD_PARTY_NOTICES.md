# 来源与第三方许可

## 原始用户脚本

- 来源：[GreasyFork 488083](https://greasyfork.org/scripts/488083)
- 原作者：`isMobile`
- 原 namespace：`noshuang`
- 原版本：`0.2.8`
- 原许可声明：`MIT`，见原件头部 `@license`。
- 原件 SHA-256：`BE4DA1E080E74B9269C189CA67E48F2DFCD20D3E7FE279461AE1EC386291D1F8`
- 保留副本：[greasyfork-488083.original.user.js](upstream/greasyfork-488083.original.user.js)

本仓库由 Waffing 发布修改版，新增模型接口替代答案查询、多协议支持、联网搜索、模型发现与设置面板，并编写使用文档。原作者信息和原始代码中的许可注记保留。CoursePilot AI 不是上游或课程平台的官方产品。

## 外部组件

脚本继续使用上游声明的 Vue、Vue Demi、Element Plus、Pinia、RxJS、blueimp-md5 等运行库和资源。运行时从脚本头部声明的地址加载；本仓库没有把这些服务或依赖当作自有产品。原始脚本内的打包组件和注记亦予保留，各组件依其自身许可使用。

脚本保留上游公告请求及其他既有资源地址。模型集成的边界和数据发送范围见 [配置说明](docs/configuration.md)。

## 发布文件

`scripts/coursepilot-ai.user.js` 与本次已验证的大模型修改版保持字节一致，仅使用更简短的发布文件名。Key、Cookie、个人导出配置及本机路径不包含在发布内容中。
