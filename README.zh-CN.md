# YT 实时翻译字幕

[English](README.md) | 中文

一个 Chrome 扩展加一个 Node.js 中转服务器，把 YouTube 视频里的语音实时变成翻译后的字幕。标签页的音频通过 OpenAI Realtime API 实时转写，每说完一句就交给大模型翻译，字幕在话音落下后很快出现在视频下方（全屏时显示在画面上）。

## 功能

- 任意 YouTube 视频都能实时出字幕，翻译成你指定的语言（默认简体中文）
- 识别过程中先显示原文，整句说完后显示译文
- 即使转写和翻译结果乱序返回，字幕也按说话顺序显示
- 字幕面板跟随 YouTube 的浅色、深色主题，全屏时切换成字幕条样式
- 点一下工具栏图标即可开始或停止翻译当前标签页
- OpenAI API Key 只保存在服务器上，不会出现在浏览器里

## 工作原理

```
 YouTube 标签页
     │ 标签页音频（chrome.tabCapture）
     ▼
 Offscreen 文档 ── AudioWorklet：立体声浮点 → 单声道 PCM16，24 kHz
     │ 每 200 ms 一段，base64 编码后通过 WebSocket 发送
     ▼
 Node.js 中转服务器（ws://localhost:8787）
     │ 1. 把音频追加到 OpenAI Realtime 转写会话
     │ 2. 语音活动检测（VAD）判断一句话在哪里结束 → 提交
     │ 3. 转写完成的句子 → 大模型翻译
     │ 4. 按序号重新排序
     ▼
 LIVE（原文）/ FINAL（译文）消息
     │ 经 WebSocket → 后台 service worker → content script
     ▼
 视频下方的字幕面板
```

**音频采集。** Manifest V3 的 service worker 不能持有媒体流，所以后台脚本先用 `chrome.tabCapture.getMediaStreamId` 拿到流 ID，再交给 offscreen 文档。offscreen 文档里的 AudioWorklet 把标签页音频混成单声道 16 位 PCM、采样率 24 kHz（Realtime API 要求的格式），然后每 200 ms 一段推送给服务器。

**切分句子。** 转写会话关闭了服务端的自动断句，由中转服务器自己判断一句话什么时候说完。服务器计算每段音频的音量（RMS）：累计至少 300 ms 的语音、之后又有 600 ms 静音，就提交这段音频。连续说话或有背景音乐时，最长 7 秒强制提交一次；一直没有语音的缓冲区会被清空。

**保证顺序。** 每段提交的音频都有一个序号。转写和翻译可能乱序返回，所以翻译好的句子先放在缓冲区里，严格按序号依次输出。如果某一段一直没回来，5 秒后跳过它，避免字幕卡住。

**稳定性。** 和 OpenAI 的连接断开时，只要浏览器端还连着，服务器就按指数退避自动重连（1 秒起，最长 30 秒）。采集状态保存在 `chrome.storage.session` 里，service worker 被浏览器回收后也不会丢。YouTube 重新渲染页面、切换视频或进入全屏时，content script 会把字幕面板重新挂到正确的位置。

## 快速开始

**环境要求：** Node.js 18 或更高版本、较新版本的 Chrome、一个可以使用 Realtime API 的 OpenAI API Key。

1. **启动服务器**

   ```bash
   cd server
   npm install
   cp .env.example .env    # 然后在 .env 里填入你的 OpenAI API Key
   npm start
   ```

   看到 `Server listening on ws://localhost:8787` 就说明启动成功。

2. **加载扩展**

   打开 `chrome://extensions`，打开右上角的 **开发者模式**，点 **加载已解压的扩展程序**，选择 `extension` 文件夹。

3. **开始使用**

   打开一个 YouTube 视频，点击扩展图标。图标上显示 **ON**，视频下方就会出现字幕。再点一次停止。

## 配置

所有配置都在 `server/.env` 里：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `OPENAI_API_KEY` | （必填） | 你的 OpenAI API Key |
| `TRANSCRIBE_MODEL` | `gpt-live-transcribe` | 实时转写模型 |
| `TRANSLATE_MODEL` | `gpt-4o` | 翻译每句话的模型 |
| `TARGET_LANG` | `简体中文` | 字幕的目标语言 |
| `PORT` | `8787` | WebSocket 端口，扩展固定连接 `ws://localhost:8787` |
| `VAD_RMS_THRESHOLD` | `500` | 判定为语音的音量阈值；背景音乐也出字幕时调高 |
| `MAX_SEGMENT_MS` | `7000` | 一段音频最长多久就送去转写（毫秒） |

## 目录结构

```
extension/
  manifest.json      Manifest V3 配置
  background.js      工具栏开关、标签页采集、状态管理、消息转发
  offscreen.html/js  音频采集与 WebSocket 推流
  pcm-worklet.js     把音频转成 PCM16 的 AudioWorklet
  content.js         在 YouTube 页面上放置和渲染字幕面板
  subtitle.css       字幕面板与全屏字幕样式
server/
  server.js          中转服务：Realtime 会话、切句、排序、重连
  translate.js       调用大模型翻译
  .env.example       配置模板
```

## 已知限制

- 服务器只在本机运行，扩展只连接 `localhost:8787`
- 每句话单独翻译，跨句子的上下文可能丢失
- 背景音乐很响的视频可能需要调高 `VAD_RMS_THRESHOLD`
- 转写和翻译都按音频时长计费，费用记在你自己的 OpenAI 账户上

## 技术栈

JavaScript、Node.js、WebSocket（`ws`）、OpenAI Realtime API、Chrome 扩展（Manifest V3：offscreen 文档、tabCapture、AudioWorklet）
