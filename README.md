# ssh-mcp

给 AI 一个真实的远程终端窗口。

不是命令执行器，是一个 SSH 会话。`ssh_open` 分配一个 PTY 跑 `ssh <host>`，`ssh_send` 往里面打一行、拿回屏幕上出现的东西。因为这一行是在远端 shell 里**原样执行**的，引号和管道就跟你亲手敲的一样，不存在 `bash -c "..."` 那种一层套一层的转义。

```text
[ssh_open]   session ssh_xxx — zmw@vps — live
             zmw@vps:~$

[ssh_send]   $ ps aux --sort=-%mem | head -3
             [vps] exit 0
             mysql  856  0.7 20.6  /usr/sbin/mysqld
             root   781  0.2  3.6  /usr/local/x-ui/x-ui

[ssh_send]   $ cd /var/log
             [vps] exit 0
             [ssh_send] $ pwd
             [vps] exit 0
             /var/log
```

## 安装

```bash
git clone https://github.com/zmw-zmw/ssh-mcp.git
cd ssh-mcp
npm install
```

只需要 Node ≥ 22。`node-pty` 是唯一的原生依赖，用来分配真实终端。

## 接入

MCP stdio server，启动命令 `node src/server.js`，无参数。

Claude Desktop / Cherry Studio 等支持 MCP 的客户端：

```json
{
  "mcpServers": {
    "ssh": {
      "command": "node",
      "args": ["/path/to/ssh-mcp/src/server.js"]
    }
  }
}
```

DeepSeek Harness（`~/.dsh/profiles/<name>/cordis.patch.yml`）：

```yaml
- insert:
    - id: mcp-ssh
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: ssh
        command: !!js process.getBuiltinModule('node:process').execPath
        args: ['/path/to/ssh-mcp/src/server.js']
        failOnStartupError: true
```

接上后工具会以 `mcp__ssh__ssh_open` 这样的名字出现。

## 工具

| 工具 | 作用 |
| --- | --- |
| `ssh_open` | 开窗口、连接、返回首屏 |
| `ssh_send` | 打一行命令，返回输出和**真实退出码** |
| `ssh_read` | 不输入，直接看屏幕 |
| `ssh_resize` | 改窗口大小（`top`、`vim` 需要） |
| `ssh_list` | 列出打开的窗口 |
| `ssh_close` | 关闭窗口 |

### ssh_send

- `line`：要敲的一行，不用自己加换行
- `raw`：原样输入不包装。用于 `y/n` 回答、Ctrl-C（`\u0003`）、交互程序按键
- `secret`：密码/口令。**只有屏幕确实在要密码时才接受**，结果里自动抹成 `<redacted>`
- `timeoutMs` / `lines`：超时和返回行数上限，默认 30 秒 / 200 行

## 完成是怎么判断的

不靠猜。每条命令都被包进一行，打印一个随机的起始标记，跑命令，再打印带状态的结束标记：

```bash
printf '\n<begin>\n'; <command>; printf '\n<end>%d\n' $?
```

看到结束标记**并带上状态**，才算完成。所以「命令跑完了吗」和「退出码是多少」都是确定的事实，而不是"输出安静了大概就完了"。

Windows 主机走 OpenSSH 会进 `cmd.exe`，那套包装会换成 `&&` / `||` 的形式，因为 `cmd` 的 `%errorlevel%` 在整行执行前就展开了，用它永远拿到 0。

## 密码与密钥

工具不存任何凭据。有密钥的话 ssh 直接登录，屏幕上不会有密码提示。

要密码的机器：`ssh_open` 返回时会说明「屏幕在等输入」，然后用 `ssh_send` 配 `secret: true` 输入。如果屏幕上没有密码提示却发了 `secret`，**会报错而不是执行**——这条是为一个真实事故加的：早先的版本里，调用方对着还没出现的密码提示发密码，结果密码被当成 shell 命令执行了。

`SSH_MCP_SSH_OPTIONS` 可以传额外的 ssh 参数（JSON 数组），用来固定私钥或 known_hosts：

```bash
SSH_MCP_SSH_OPTIONS='["-i","/home/me/.ssh/id_ed25519"]'
```

不设置就走 `~/.ssh/config`。

## 测试

```bash
npm test                    # 28 项纯函数检查，不联网
npm run test:e2e -- <host>  # 18 项端到端检查，需要一台免密登录的主机
```

端到端会真的开窗口、登录、跑命令，覆盖状态码、跨调用状态、引号、循环、长输出截断、交互输入、危险命令提示和清理。

## 真实主机教出来的坑

下面每一条都是在真机上跑挂了才发现并修掉的，不是设计时想到的。列出来是因为决定要不要用这个工具的人，应该看到它已经踩过哪些坑。

| 症状 | 原因 | 修法 |
| --- | --- | --- |
| `ssh_open` 一秒内返回空屏幕 | PTY 最先吐的是终端初始化转义序列，把"有字节"当成了"有内容" | 判断可见文本，不判断长度 |
| 密码被当成命令执行 | 密码提示还没出现，调用方就发了密码 | 没有提示时拒绝 `secret` |
| 命令一直显示"还在运行"直到超时 | 交互式 bash 展开 `!`，`!b: event not found` 直接中止整行 | 登录时发 `set +H` |
| 同样的症状，换台机器 | 远端把输出和状态不加换行连着吐，行首匹配的规则永远命中不了 | 按标记后面的状态匹配，不看位置 |
| 屏幕上一堆命令挤在一行 | 远端提示符前面没有换行 | 在标记状态后断行 |

## 已知限制

- **Windows 远端的 `cmd`**：没有单行循环（`%i` 整行只展开一次），`%errorlevel%` 不可用。真要在 Windows 上跑循环，用 `powershell -Command`。
- **终端不是管道**：二进制输出和超宽输出会被折行。
- **忽略包装的 shell**：仍能工作，但不报退出码，超时后返回部分输出。
- **`set +H`**：在 POSIX 登录时发送，让 `!` 保持字面量。如果某个 shell 的 rc 文件在之后又打开了历史展开，这类命令仍会失败。
- **不做命令拦截**：危险命令（`rm -rf /`、`mkfs`、`reboot` 等）只在结果里加一句提示，不阻止执行。要不要执行由人决定。

## 许可证

MIT
