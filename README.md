# dsh-session-admin

DSH Web GUI 的**会话管理插件**：列出所有已存储会话，归档 / 取消归档，以及**真正删除**。

## 为什么需要它

DSH 0.2.x **没有删除会话的 API** —— `sessionPersistence` 只有 `create/open/stat/list/flush`，
`sessions` 只有 `create/prepare/enter/announce/flush/get/list/fork`。所以"真正删除"只能
直接删磁盘上的工件。

而这正是别的"真删"插件翻车的地方：**只要会话还活在宿主内存里（live），删完文件它还会自己
写回来**，重启后又出现。旧插件只跳过 `agent.status === 'running'`，而 `running`（正在生成
回复）和 `live`（已加载进内存）是两回事，所以 idle 但 live 的会话必然复活。

## 怎么解决的：墓碑 + 启动重放

```
删除请求
 ├─ 非 live → 直接删文件（干净）
 └─ live    → 记一条墓碑 + 尝试释放 + 删文件，并如实标记 pending
宿主每次启动（+5 秒后补一次）→ 重放墓碑：此时没人打开它们，删了就真没了
确认消失且不再 live 后，墓碑才被清掉
```

每次删除同时清理：会话目录 · 投影缓存 · 归档集合 · workspace 记账。

**设计上的取舍**：host 半侧只依赖文件系统 + 两个可选服务（`workspaceRegistry` 管归档集合、
`sessions` 做 liveness 探测），**不使用任何私有 API**，所以将来 DSH 重构时它是降级而不是
崩掉。

## 功能

| 功能 | 说明 |
| --- | --- |
| 会话列表 | 标题、工作区、最近修改、大小、`内存中` / `已归档` 标记 |
| **移入回收站** | **不是直接抹掉**：连会话目录带投影缓存一起移进 `sessions-trash`，保留 **90 天** |
| **恢复** | 从回收站放回**原来的工作区**，缓存一并还原 |
| **彻底清除 / 清理过期** | 手动清单个，或清掉超过 90 天的（列回收站时也会自动清） |
| 空会话折叠 | 只开过没用过的会话（只有头部记录）默认隐藏，可展开 |
| 归档 / 取消归档 | 官方只有归档没有取消，这里补上 |
| 墓碑状态 | 界面会提示还有几个待下次启动处理 |

> 导出没有做：官方 `/export` 已经够用，不重复造。

### 回收站

```
$DSH_HOME/sessions-trash/<删除时间戳>-<会话 id>/
├─ meta.json      原工作区、标题、大小、删除时间
├─ session/       会话目录（原样搬过来）
└─ cache.json     投影缓存（原样搬过来）
```

每个条目自带元数据，没有全局清单，所以**不会出现清单和实际文件对不上**的情况。目录名以时间戳开头，
天然按时间排序；恢复就是原路搬回去。**过期清理在两个时机触发**：宿主启动时，以及每次打开回收站时。

## 安装

本包是 **DSH 组合包（bundle）**：profile 只要把包名选进 `dsh.profile.bundles`，加载器就会
应用自带的 `cordis.patch.yml`。

```powershell
cd dsh-session-admin
.\install.ps1 -Profile desktop          # 默认就是 desktop
.\install.ps1 -Profile desktop -DryRun  # 只看将要做的改动
.\install.ps1 -Profile desktop -Uninstall
```

**从 GitHub 安装** —— 走 profile 自己的插件管理器（设置里的「插件」页），填仓库地址：

```
https://github.com/Full626/dsh-session-admin
```

或命令行：

```powershell
dsh plugin --profile desktop add 'github:Full626/dsh-session-admin'
```

装完**重启应用**（新组合层要下次组合才生效），然后 **设置 → 会话管理**。

## 验证

主机半侧有一套**不碰真实数据**的测试：它在临时 `$DSH_HOME` 里造出假会话，用最小 fake
ctx 驱动真实插件代码，专门覆盖那个回归——**假造"内存回写"，再验证启动重放把它清掉**。

```powershell
node scripts/test-host.mjs     # 27 项：列表/删除/墓碑/重放/归档/错误处理
```

跑在真实桌面端上的检查（只读）：

```powershell
# 只读：列出会话、墓碑状态
node scripts/check-api.mjs --url http://127.0.0.1:19387

# 真要删几个（谨慎）
node scripts/check-api.mjs --url http://127.0.0.1:19387 --delete session-xxxx
```

接口本身：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/list` | 会话列表 + 待处理墓碑 + 保留天数 |
| GET | `/trash` | 回收站条目（顺带清理过期项） |
| GET | `/state` | 墓碑、home、两个根目录、保留天数 |
| POST | `/delete` | body `{"ids":[...]}` —— **移入回收站** |
| POST | `/restore` | `/purge` | `/purge-expired` | 回收站操作 |
| POST | `/archive` | `/unarchive` | 归档集合 |

## 已知限制

- 删除会保留 **90 天**；「彻底清除」和过期清理才是不可恢复的。
- 回收站占用磁盘：删得多了记得清（或让它自己过期）。
- 宿主正在运行某个会话时不会删它（会跳过并告诉你），这是刻意的。
- 会话正文是 JSONL + 多帧 zstd，本插件只做**管理**，不解析正文内容。
- 路径布局按 DSH 0.2.x 的 `$DSH_HOME/sessions/<工作区编码>/<会话 id>/` 解析；将来若改布局，
  列表会变空而不是误删。

## 许可

MIT，见 [LICENSE](LICENSE)。
