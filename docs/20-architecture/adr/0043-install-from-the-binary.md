# ADR-0043 安装脚本跟着二进制走：`webterm install`、装前实签、装完配对

状态：已接受（2026-10-31）。改的是 [`install.md`](../../80-ops/install.md) 的流程和 `scripts/install.sh` 的结构；`webterm update` 仍然是 install.sh 的薄壳（不变）。

## 背景

用户问「在新服务器上用要做些什么、能不能简化」。照原来的文档走一遍，问题如下：

1. **私有仓库要先在服务器上 `gh auth login`**。这样做有两个代价：多一次浏览器设备授权；在一台把 shell 挂到公网的机器上，留下了一个能写用户**所有仓库**的 token。攻破 webterm 的人拿到的就不止这台机器了。
2. **脚本和二进制的版本会错开**。install.sh 总是从 `main` 取，二进制默认取 `latest`（当时还是 v0.1.0，落后 main 55 个提交）。main 上的脚本写的是 ADR-0034 的系统单元（`OOMScoreAdjust=-900`），而 v0.1.0 起 shell 时不会把会话调回 0，于是**会话里所有进程都是 -900**，内存吃紧时内核反倒去杀别的进程。
3. **staging 那一步是坏的**，见 [ADR-0042](0042-ip-address-certificates.md) §3。而且手工步骤多：先停服务，再用 staging 跑一遍，Ctrl+C，再启动服务。
4. **安装前的自检查不出最常见的故障**。云安全组有没有放行 80，在机器内部看不出来，`doctor` 自己也承认这一点。
5. **装完不出二维码**。脚本开头注释写着「启动并打出配对二维码」，实际只提示你再去跑 `webterm pair`。
6. README 说「`scp` 上去 `./webterm serve` 就能用」，但普通用户没做 setcap 就绑不上 80/443，这条路走不通。

## 决策

### 1. install.sh 嵌进二进制，`webterm install` 用自己装自己

`scripts/embed.go` 用 `go:embed` 把 `scripts/install.sh` 编进二进制。`webterm install [参数]` 把它写到临时文件里，加上 `--binary <自己的路径>` 交给 bash 执行，stdin、stdout、stderr 都直通终端（sudo 要问密码）。

```bash
scp webterm server:  &&  ssh -t server ./webterm install
```

不联网下载、不需要 GitHub 凭据，README 承诺的 scp 流程也终于能走通了。**升级也走这条路**：scp 新版本过去，再跑一次 `./webterm install`。脚本本来就会判断「已经在跑、支持交接」，然后走热升级（ADR-0016）。

**脚本仍然是唯一的安装逻辑**，Go 这边只负责把它取出来执行，不重写一遍。不把它改写成 Go 的原因和 `webterm update` 当初选「薄壳」一样：升级路径上的知识（setcap 会随替换丢失、单元跟着端口走、迁移不能在自己的会话里做……）只放在一个地方，就不会出现两份互相漂移。

### 2. 从网上取的 install.sh 只负责下载，然后把后续交给下载来的二进制

`curl … | bash` 和 `gh api … | bash` 取到的脚本，在**下载并校验完 SHA256 之后**执行：

```bash
"$TMP/webterm-linux-<arch>" install <原样的参数>
```

后面的步骤由**这个二进制自带的那份 install.sh** 完成。这样脚本和二进制永远是同一个版本，背景第 2 条的错位从结构上就不可能发生。

下载来的二进制如果不认识 `install`（v0.1.0 及更早），脚本**直接拒绝**，说明原因和办法（`--channel dev`，或者等 v0.2.0）。不能退回去用当前这份脚本接着装：那正是要消除的错位。

`--dry-run` 不下载，所以不交接，仍然由当前脚本打印它将要执行的步骤。

### 3. 不给 `--domain` 时的默认值

按顺序：

1. 有 `~/.config/webterm/install-state`（以前装过）→ **原样沿用那套参数**，命令行上给的追加在后面，覆盖同名参数。所以在已经装好的机器上跑 `./webterm install` 就是「用这个二进制，按原参数重装或升级」。
2. 都没有 → 取本机公网 IPv4（`api.ipify.org`，取不到再试 `ifconfig.me`），走 IP 模式（ADR-0042）。会明确打印「没指定 --domain，用本机公网 IP x.x.x.x」。

`--dev` 和 `--no-service` 不需要地址，不受影响。

配置文件里的 `domain` / `http-port` / `https-port` 改成**每次安装都同步**：有这一行就改写，端口回到默认值就删掉这一行；其它键（用户自己加的 `session-env` 等）保持不动。原来的做法是「文件存在就整份不动」，从 IP 换到域名之后，`pair`、`doctor` 和状态总览还会继续用旧地址。

### 4. 装前用 staging 实签一次：`webterm doctor --acme`

`doctor` 加一个 `--acme` 开关。在静态检查都通过后，它**临时监听** `--http-port` / `--https-port`，用 Let's Encrypt staging 实际签一张证书（缓存放临时目录，用完就删），把结果当作一项检查报告出来，然后释放端口。

这是唯一能在机器内部证明「CA 从公网连得进来」的检查，云安全组、NAT、运营商封 80 都会在这一步暴露出来。staging 的限额很宽，多跑几次也没关系。

install.sh 在**首次安装**（服务没在跑）时，在 setcap **之后**、启动服务**之前**跑它：要用已经有绑定权限的那个二进制，端口也还空着。原来在安装之前用临时二进制跑的静态自检合并进这一步。跑在 setcap 之后，「没有绑定权限」那条 ⚠ 就不会再出现了。

不通过就中止（`--force` 可以跳过）。这时二进制已经装好，但服务没有写也没有启动，修好之后重跑同一条命令即可。

升级时（服务在跑）不跑：端口正被它自己占着。

文档里原来的手工第 5 步（停服务 → `serve --acme-staging` → Ctrl+C → 再启动）**删掉**。`serve --acme-staging` 保留，留给排障用，它的证书放在 `certs-staging/`（ADR-0042 §3）。

### 5. 机器自己的防火墙由脚本放行

首次安装时，如果检测到：

- `ufw` 已启用（`/etc/ufw/ufw.conf` 里 `ENABLED=yes`，这个文件普通用户也能读），就执行 `sudo ufw allow <端口>/tcp`；
- `firewalld` 在跑，就执行 `sudo firewall-cmd --permanent --add-port=<端口>/tcp` 并 `--reload`。

做了什么都打印出来。装的就是一个要监听这两个端口的服务，放行它们是安装的一部分，不另设开关。**云安全组碰不到**，靠第 4 条把它测出来。

### 6. 首次安装结束时直接配对：`webterm pair --wait`

服务启动后，首次安装会执行 `webterm pair --wait`：先等本机 HTTPS 用**系统信任的证书**能打开（连 `127.0.0.1:<https-port>`，按 `--domain` 校验证书，最多等 90 秒），再打印配对 URL 和二维码。不等的话，扫码后手机上看到的是证书错误。

90 秒内证书还没好，就提示去看 `journalctl -u webterm`，配对码照样打印出来：配对码 5 分钟有效，证书随后签下来也还来得及用。

升级不打印配对码。`--no-service` 安装也不打印：手工跑 `serve` 时，如果还没有授权设备，它自己会打印。

## 后果

新服务器上的完整步骤：

```bash
# 机器之外，只有一件事：云安全组放行入方向 TCP 80、443（有域名的话再加一条 A 记录）
scp webterm server: && ssh -t server ./webterm install            # IP 模式
scp webterm server: && ssh -t server ./webterm install --domain term.example.com
# → 放行防火墙 → staging 实签自检 → 装好并启动 → 打出二维码 → 扫码
```

- 私有仓库不再需要在服务器上留 GitHub 凭据。`gh` / `GH_TOKEN` 那条路仍然保留，`webterm update` 用的就是它。
- 发正式版 v0.2.0 之前，`latest` 还是 v0.1.0，默认渠道下载到它会被第 2 条拒绝。在那之前从网上装要加 `--channel dev`，文档里写明了；走 `webterm install` 的不受影响。
- install.sh 新增 `--binary <路径>`：用本地二进制，跳过下载和校验（文件是你自己给的）。
- 交接后安装步骤会重新从 1/6 编号。交接时会打印一行「交给 webterm vX 自带的安装脚本继续」，用户不会误以为装了两遍。
