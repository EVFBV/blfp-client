# BLFP Client

BLFP 是面向 Minecraft Java 版的联机客户端，提供 WebRTC P2P 直连和 frp 中转两种房间连接方式。

## 主要功能

- WebRTC P2P 端到端联机
- frp 公网节点中转联机
- 首页快捷创建 P2P / frp 房间
- Minecraft 局域网 MOTD 广播
- 房间成员、延迟与在线人数显示
- 普通用户最多 8 人、赞助用户最多 12 人
- 三种侧边栏模式：正常、折叠、悬浮伸缩
- GitHub Releases 客户端更新检测
- HTTPS/WSS、JWT 鉴权与 HMAC 请求签名

## 工作原理

### EasyTier 模式（默认）

- 房主创建房间，服务端分配 6 位房间号和该房间独立的临时网络凭据
- 房主与加入者通过 EasyTier 连接共享节点，并自动尝试建立 P2P 直连
- 直连受限时，游戏流量自动经共享节点中继
- 加入者在 Minecraft 中连接房主的 EasyTier 虚拟地址即可

### frp 中转模式

- 房主选择 frp 固定中转节点
- 客户端自动启动 frpc，将本机 Minecraft 端口映射到公网
- 加入者输入房间号后直接获得公网地址并连接

## 下载与安装

请前往 [Releases](https://github.com/EVFBV/BLFP-client/releases) 下载最新的 `BLFP-Setup-v*.exe`，运行安装程序并按界面提示完成安装。

## 本地开发

需要 Node.js 20 或更高版本。

```powershell
npm ci
npm start
```

## 构建

构建 Windows 安装包：

```powershell
npm run dist
```

推送 `v*` 标签后，[GitHub Actions](https://github.com/EVFBV/BLFP-client/actions) 会自动构建并创建 Release。

## 使用说明

1. 登录 BLFP 客户端。
2. 在首页选择 P2P 或 frp 模式。
3. 输入 Minecraft 局域网开放端口并创建房间。
4. 将六位房间号发送给好友。
5. 好友输入房间号加入后，在 Minecraft 多人游戏中连接显示的本地地址。

## 社区

QQ 交流群：`229527551`

## 安全说明

请勿将 GitHub Token、服务端密钥或本地环境变量提交到仓库。GitHub 自动发布使用 Actions 提供的仓库级 `GITHUB_TOKEN`。

## License

MIT
