# 可选补丁：让审批优先走聊天

DSH 默认把审批请求转发给浏览器页面。本插件通过事件优先级实现双通道审批，不需要修改 DSH。应用本补丁后，浏览器不再接收审批请求，审批完全由本插件接管（聊天应答）。

## 何时需要

- 希望审批只出现在聊天里，页面不弹审批
- DSH 页面长期不开，但希望审批稳定落到聊天

不打补丁时行为：页面开着走页面，页面没开走聊天，两边都可用。

## 补丁内容

文件：

```
node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-api-remotes/lib/index.js
```

从 `API_REMOTE_FORWARDED_EVENTS` 数组中移除这一条：

```js
{
    event: "approval/request",
    mode: "waterfall"
},
```

修改后重启 DSH 生效。

## 注意

- DSH 升级会覆盖该文件，升级后需要重新应用
- 应用后 DSH 页面不再显示原生审批弹窗
- 该补丁与插件无依赖关系，插件在不打补丁时功能完整
