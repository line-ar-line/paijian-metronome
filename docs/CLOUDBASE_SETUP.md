# 拍间社区接入腾讯云 CloudBase PostgreSQL

本项目使用已创建的上海地域环境。节拍器与曲谱工具继续由 GitHub Pages 发布；社区试用页面放在 CloudBase 已允许的默认域名下，GitHub 社区页提供“打开打卡试用版”按钮，由用户点击进入。社区使用用户名与密码注册、登录，CloudBase Auth 管理账号与会话，PostgreSQL RPC 保存打卡、动态和排行榜。

| 项目 | 实际配置 |
| --- | --- |
| 环境 ID | `fast-junglefowl-d3fqxnq941dd1c4e` |
| 地域 | 上海，`ap-shanghai` |
| 数据库模式 | **PostgreSQL**，`DocumentExt: false` |
| 云端实例 | `postgres-kkeugpri`，共享实例 |
| 网站 | `https://line-ar-line.github.io/paijian-metronome/` |
| 社区试用页 | `https://fast-junglefowl-d3fqxnq941dd1c4e-1528285429.tcloudbaseapp.com/paijian/community.html` |
| HTTP 注册入口 | `https://fast-junglefowl-d3fqxnq941dd1c4e-1528285429.ap-shanghai.app.tcloudbase.com/community-register` |
| 已允许的 Web 安全域名 | `fast-junglefowl-d3fqxnq941dd1c4e-1528285429.tcloudbaseapp.com` |
| 当前套餐 | 免费体验版，`baas_trial` |

以上数据库模式已按云端实际配置核对。本环境使用 SQL 表、GRANT 和 RLS 权限，初始化入口是本文的 SQL 文件。

当前免费套餐添加 GitHub 域名时，`CreateAuthDomain` 实际返回 `OperationDenied.FreePackageDenied`。因此先用默认域名完成试用，不升级付费。默认域名是开发测试入口，有访问提示中间页和频率限制；它不构成正式社区的长期免费托管承诺。具体限制见本文第 9 节。

截至 2026-11-09，用户名密码版本的 SQL、注册云函数、HTTP 类型 6 路由与社区页面均已部署，静态文件校验通过。已在实际电脑和手机页面用两个临时账号验证注册、正确及错误密码登录、私密打卡隔离、分享及撤回、周榜和刷新恢复；重名注册被拒绝，未发起邮箱验证请求，测试账号及关联打卡均已清理。GitHub 域名直接使用社区服务仍受体验套餐安全域名限制。

环境 ID、地域和公开注册 URL 可写入网页。腾讯云 SecretId、SecretKey、CLI 登录凭据及管理员 API Key 不能写进网页或仓库。用户密码仅在本次注册或登录请求中传输；不写入打卡表、页面日志、localStorage 或 sessionStorage。浏览器可以由官方 SDK 保存登录会话，保存会话不等于保存密码。

## 1. 授权 CLI 并确认环境

命令已按官方 **CloudBase CLI 3.9.2** 帮助核对。建议使用 Node.js 20.19 或更新版本，与注册函数运行时保持兼容。在项目根目录执行：

```sh
npm install -g @cloudbase/cli@3.9.2
tcb --version
tcb login
```

`tcb login` 默认显示腾讯云官方授权链接和用户码。在自己的浏览器打开链接，登录拥有该环境的账号并确认授权；终端自动完成登录。不需要复制或提供云 API 密钥。

确认资源：

```sh
tcb env detail -e fast-junglefowl-d3fqxnq941dd1c4e -r ap-shanghai --json
```

应能看到 PostgreSQL 已开通。文档型数据库列表为空不等于“数据库没创建”，无需重新创建环境或升级套餐。

用明确的查询测试 SQL 通道：

```sh
tcb db execute -e fast-junglefowl-d3fqxnq941dd1c4e -r ap-shanghai --sql 'SELECT current_database(), current_user;' --json
```

`--read-only` 在 CLI 3.9.2 中仅适用于 MySQL，在 PostgreSQL 环境会被忽略。只读核查使用本文给出的 `SELECT`；不要把这个参数当成防误写保护。

## 2. 启用用户名密码登录

打开 [CloudBase 控制台](https://tcb.cloud.tencent.com/dev)，选择环境，在 **身份认证 → 登录方式** 确认用户名密码登录已开启。CLI 可查询并只修改这个开关，保留其他登录方式：

```sh
tcb env login get -e fast-junglefowl-d3fqxnq941dd1c4e -r ap-shanghai --json
tcb env login set -e fast-junglefowl-d3fqxnq941dd1c4e -r ap-shanghai --username-login true --json
```

查询结果中的 `UserNameLogin` 应为 `true`。对应管理 API 是 `DescribeLoginConfig` / `ModifyLoginConfig`；直接使用修改 API 时，须先读取当前值，并保留其他登录开关。

CloudBase [官方用户名登录说明](https://docs.cloudbase.net/authentication-v2/method/username-login)明确不提供浏览器直接使用纯用户名与密码注册的流程。本项目因此采用以下链路：

1. 网页将用户名与密码通过 HTTPS 发送到本项目的注册云函数。
2. 云函数校验格式和注册次数，检查现有账号并预占用户名，再使用服务端 Manager SDK 的 `createUser` 创建 `externalUser`、`ACTIVE` 普通账号，不接受客户端指定角色或账号类型。
3. 创建成功后，网页通过官方 Web SDK 的 `auth.signInWithPassword({ username, password })` 登录，之后使用 SDK 会话调用四个社区 RPC。

注册规则为：用户名 3–32 位，字母开头、字母或数字结尾，中间可用字母、数字、下划线和短横线；保留用户输入的大小写。密码 8–32 位，以字母或数字开头，大写字母、小写字母、数字、特殊字符至少三类，允许的特殊字符为 `()!@#$%^&*|?><_-`，不允许空格或反斜杠。密码不会被自动去除首尾空格；不符合规则时应由用户重新输入。

账号创建成功但自动登录失败时，页面会提示“账号已创建”并切回登录，保留用户名、清空密码，避免让用户重复注册。**当前没有自助找回密码功能，请记好用户名和密码。**

迁移保留已有邮箱账号、原有打卡数据及仍有效的 CloudBase 会话，不删除账号、不替换用户 ID。已有邮箱账号不会自动获得一个新用户名或密码；如果其旧会话仍有效，可以继续访问原记录。

## 3. 使用已允许的默认域名

本环境已允许以下域名，且静态托管状态已核对为 `online`：

```text
fast-junglefowl-d3fqxnq941dd1c4e-1528285429.tcloudbaseapp.com
```

核对命令：

```sh
tcb cors list -e fast-junglefowl-d3fqxnq941dd1c4e -r ap-shanghai --json
tcb hosting detail -e fast-junglefowl-d3fqxnq941dd1c4e -r ap-shanghai --json
tcb hosting list -e fast-junglefowl-d3fqxnq941dd1c4e -r ap-shanghai --json
```

当前环境不能添加 `line-ar-line.github.io`：云端返回的是套餐限制，反复提交相同请求不会解决。将社区网页托管在上面的既有域名，浏览器从这个域名直接发起认证和数据请求。GitHub 页面负责解释试用状态并提供前往试用页面的按钮，不自动跳转。

将来如改用支持添加域名的套餐，再单独配置 GitHub 域名或自有域名。安全域名只填写主机名，不带 `https://`、页面路径或通配符；自有托管域名还需按平台要求完成备案与绑定。此指南不自动升级套餐。

## 4. 应用 CloudBase 专用 SQL

数据库初始化文件是 [cloudbase/schema.sql](../cloudbase/schema.sql)。使用这份适配 CloudBase 的版本，不要直接运行 `supabase/schema.sql`。

CloudBase 的 `auth.uid()` 返回文本，实际身份来自登录 JWT 中的 `sub`。本环境的 `auth.users.id` 是内部 `bigint`，`sub` 和 `project` 是文本列。SQL 从可信登录身份及所属环境找到唯一、有效的用户，再关联内部数字主键；网页不传入内部主键来决定数据归属。认证不再依赖邮箱验证标志：当前环境的 `status = 1` 表示有效账号，旧邮箱外部账号的 `NULL` 状态继续兼容；被停用账号仍被拒绝。

初始化会创建：

| 对象 | 用途 |
| --- | --- |
| `public.community_profiles` | 用户公开昵称 |
| `public.community_checkins` | 用户自己的每日打卡、时长、曲目、心得和公开状态 |
| `community_private` 下的辅助函数 | 日期、输入校验与有效账号身份检查 |
| `public.community_dashboard()` | 本人统计、历史以及允许公开的动态和周榜 |
| `public.community_update_profile(...)` | 修改本人的昵称 |
| `public.community_check_in(...)` | 按北京时间保存今日打卡并防止重复 |
| `public.community_set_checkin_public(...)` | 修改本人记录的分享状态 |

`cloudbase/schema.sql` 已封装为一个完整的 `DO $community_migration$ … $community_migration$` 语句，包含建表、函数、索引及全部权限设置。在项目根目录执行：

```sh
tcb db execute -e fast-junglefowl-d3fqxnq941dd1c4e -r ap-shanghai --sql "$(cat cloudbase/schema.sql)" --json
```

也可将整个文件交给 CloudBase 的 PostgreSQL SQL 编辑入口执行。执行失败时保留错误并修正；文件可重复应用，不删除现有账号、昵称或打卡记录。

维护迁移文件时注意：

- `ExecutePGSql` 每次接收一条 SQL。本文件的最外层 `DO` 满足这个要求；不要在块外追加其他 SQL 后继续使用同一命令。
- 函数体含有分号和美元引号，不能按分号或换行拆分文件。保留最外层块及完整的函数定义。
- 省略 `--role` 时使用平台提供的应用管理角色；不要手动指定平台内部的 `postgres` 等保留角色。
- 单独调试 DDL 时，部分直接调用可能返回 `InternalError`；官方建议在 `DO LANGUAGE plpgsql` 块中通过动态 `EXECUTE` 执行。修复时保留完整语句及正确引用。

## 5. 核对表权限与 RPC

本项目不给普通网页客户端直接访问业务表的权限。两张表启用 RLS，并撤销匿名和登录角色的表级直接读写；允许的操作都经四个 RPC 完成。每个 RPC 再检查可信登录身份、所属环境与账号状态，不能接受前端传入用户 ID 来决定数据归属。历史辅助函数名 `require_verified_user` 为兼容升级而保留，其检查对象是有效账号，不再是邮箱验证状态。

核查表和 RLS：

```sh
tcb db execute -e fast-junglefowl-d3fqxnq941dd1c4e -r ap-shanghai --sql "SELECT schemaname, tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('community_profiles', 'community_checkins') ORDER BY tablename;" --json
```

两张表都应存在，`rowsecurity` 应为 `true`。核查匿名和登录角色没有直接读写权限：

```sh
tcb db execute -e fast-junglefowl-d3fqxnq941dd1c4e -r ap-shanghai --sql "SELECT r.role_name, t.table_name, has_table_privilege(r.role_name, t.table_name, 'SELECT') AS can_select, has_table_privilege(r.role_name, t.table_name, 'INSERT') AS can_insert, has_table_privilege(r.role_name, t.table_name, 'UPDATE') AS can_update, has_table_privilege(r.role_name, t.table_name, 'DELETE') AS can_delete FROM (VALUES ('anon'), ('authenticated')) AS r(role_name) CROSS JOIN (VALUES ('public.community_profiles'), ('public.community_checkins')) AS t(table_name);" --json
```

上面四类权限都应为 `false`。核查四个 RPC 是否存在：

```sh
tcb db execute -e fast-junglefowl-d3fqxnq941dd1c4e -r ap-shanghai --sql "SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS arguments, p.prosecdef AS security_definer FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN ('community_dashboard', 'community_update_profile', 'community_check_in', 'community_set_checkin_public') ORDER BY p.proname;" --json
```

[cloudbase/verify.sql](../cloudbase/verify.sql) 提供单条 `DO` 核查，包括无效身份 RPC 拒绝、ACL 断言、两表 RLS 与四个函数的固定搜索路径。更新 SQL 后应再次在实际环境执行并记录结果，可按初始化文件的整文件方式执行。

看到函数存在只是结构检查，还需做后面的真实账户验收。管理员 SQL 通道会绕过普通用户的部分权限，管理员能查询数据并不能证明网站用户权限正确。

## 6. 部署注册入口和社区试用页

先应用注册次数限制 SQL：

```sh
tcb db execute -e fast-junglefowl-d3fqxnq941dd1c4e -r ap-shanghai --sql "$(cat cloudbase/registration.sql)" --json
```

[注册限流脚本](../cloudbase/registration.sql)在 `community_private.registration_buckets` 中保存 IP 哈希及计数，不保存原始 IP、用户名或密码。限额采用固定窗口：**每 IP 每分钟 5 次、每小时 20 次，全站每个北京时间日 100 次**。格式合法的请求在创建账号前占用额度，创建失败也计入；已超限请求不继续增加计数。数据库不可用时停止注册，不绕过限额。

同一脚本还创建管理员专用的 `community_private.registration_names`，仅保存小写用户名及 10 分钟到期时间，不保存密码。云函数在创建账号前检查已有账号，并原子预占用户名，避免重复请求同时创建同名账号。重名检查不区分大小写，停用账号仍保留其用户名；实际创建时保留输入的大小写。创建中断时预占暂时保留，到期后可重试；若账号已创建，仍按已有账号处理。普通客户端无权读写这些表或调用预占函数。

注册服务代码在 [cloudbase/functions/register](../cloudbase/functions/register)。它只接受规定的注册请求与来源，使用云函数执行角色提供的临时凭据调用用户管理和管理 SQL；没有浏览器管理员密钥。部署前确认函数角色具备这两个操作的权限。HTTP 函数监听 `9000` 端口，`scf_bootstrap` 是启动入口。

在项目根目录安装固定依赖并部署：

```sh
npm ci --prefix cloudbase/functions/register --omit=dev
tcb fn deploy paijian-register --dir cloudbase/functions/register --httpFn --runtime Nodejs20.19 --install-dependency false -e fast-junglefowl-d3fqxnq941dd1c4e -r ap-shanghai --json
```

命令读取 [cloudbaserc.json](../cloudbaserc.json) 中的配置，包括 HTTP 类型、Node.js 20.19、30 秒超时和 256 MB 内存。本地安装的依赖随函数包上传。首次部署函数后，单独创建 HTTP 访问路由：

```sh
tcb service create --service-path /community-register --function paijian-register -e fast-junglefowl-d3fqxnq941dd1c4e -r ap-shanghai --json
```

后续更新函数只运行 `fn deploy`，无需重复创建路由。CLI 3.9.2 的 `fn deploy --path` 曾将这个 HTTP 函数绑定为 Event 路由（类型 `1`），请求返回 `FUNCTIONS_PARAM_INVALID`；上面的 `service create` 会识别 HTTP 函数并创建正确的类型 `6` 路由。维护时核对路由类型与函数绑定，不删除其他已有服务。

从服务创建输出或 HTTP 网关详情取得实际 HTTPS URL，先检查 GET 健康响应和允许来源的 OPTIONS 预检；不要用真实用户密码做命令行探针。健康检查通过只说明入口可达，真实注册还需第 7 节验收。

生产入口由 CloudBase HTTP 网关统一添加 CORS 响应头。函数启动时设置 `gatewayCors: true`，避免函数和网关同时返回 `Access-Control-Allow-Origin` 导致浏览器拒绝请求；本地独立 HTTP 测试使用函数自身的 CORS 响应。函数仍严格检查允许的 `Origin`、请求方法与预检头，平台安全域名检查保持开启，不通过关闭 `safeDomain` 解决跨域问题。

已部署的 [community/config.js](../community/config.js) 使用：

```js
window.PAIJIAN_COMMUNITY_CONFIG = {
  provider: 'cloudbase',
  envId: 'fast-junglefowl-d3fqxnq941dd1c4e',
  region: 'ap-shanghai',
  registrationUrl: 'https://fast-junglefowl-d3fqxnq941dd1c4e-1528285429.ap-shanghai.app.tcloudbase.com/community-register',
  enabled: true,
};
```

以上配置已启用。迁移到其他环境时，先确认新版 SQL、注册限流、函数执行权限、注册 URL、默认域名和密码登录全部配置完成，再启用页面。`registrationUrl` 是公开入口地址；网页使用用户登录后由 SDK 管理的会话调用 `app.rdb().rpc(...)`，无需在前端配置 `service_role` 管理密钥。

在项目根目录使用 `tools/build-community-hosting.cjs` 创建一个新的发布目录。脚本只打包社区 HTML、样式、`community/` 客户端文件以及两个本地 SDK；入口脚本处理域名入口及返回 GitHub 工具页的导航。然后上传到 `/paijian/` 子目录：

```sh
paijian_publish_root="$(mktemp -d)"
node tools/build-community-hosting.cjs --output "$paijian_publish_root/site"
tcb hosting deploy "$paijian_publish_root/site" paijian -e fast-junglefowl-d3fqxnq941dd1c4e -r ap-shanghai --entry community.html --verify --json
```

`hosting deploy` 只上传准备好的文件，不执行构建。只上传上述脚本生成的社区目录，不上传整个仓库。命令中的云端前缀写为 `paijian`（不加前导斜杠，避免 CLI 3.9.2 的校验路径不匹配）；实际访问路径为 `/paijian/`。不使用 `--prune`，保留云端根目录已有的系统认证文件。先确认社区试用 URL 可访问、静态资源加载正确，再发布 GitHub 上指向该 URL 的入口。

随后提交并推送到现有 GitHub 仓库，保持 **GitHub Pages → main / (root)**。CloudBase 文件上传、数据库初始化和 GitHub Pages 发布是独立步骤：推送 GitHub 不会自动更新 CloudBase 文件或应用 SQL。

## 7. 用两个普通账号完成真实验收

本地模拟测试能检查页面、认证适配和数据库逻辑，但不能替代云端权限验收。在普通窗口和无痕窗口分别使用 A、B 两个普通账号操作：

1. 注册 A，确认无需邮箱即可创建并登录；退出后使用用户名与密码重新登录，错误密码不能建立会话。用户名占用、密码不合规则应得到明确反馈。
2. A 保存昵称，提交默认私密打卡。刷新、退出再登录后，个人记录与统计仍存在。
3. A 同一天再次提交不能生成第二条记录或重复累计分钟数；另一设备提交也应保留已有记录。
4. B 登录后看不到 A 的私密记录，无法修改 A 的记录。
5. A 分享打卡后，B 刷新可见动态及其周榜贡献；A 取消分享后，B 刷新不再看到这些公开内容，A 自己的累计不减少。
6. 公开动态使用昵称，不泄露登录用户名或历史账号邮箱。退出登录后页面清空私人记录与密码框；切换账户不会显示前一个账户的统计。
7. 普通用户直接访问两张业务表和注册计数表应被拒绝；四个 RPC 中本人允许的操作成功。匿名、停用账号以及伪造用户 ID 不能取得私人数据或写入。
8. 手机通过 GitHub 的入口进入社区试用页，按平台提示确认访问后，完成登录、打卡和查看动态。节拍器等 GitHub Pages 页面入口仍受当地网络影响。
9. 若已有邮箱账号及有效会话，升级后确认仍能读取原有打卡；无需重新创建账号或迁移记录。真实注册限流检查应控制测试次数，避免消耗整个环境当日名额。

上线记录应区分“模拟测试通过”“新版 SQL 应用成功”“注册函数及页面发布成功”“真实注册登录通过”“双账户权限验收通过”。没有进行真实注册或双账户验证时，应明确标为待验收。

## 8. 本地复现数据库与客户端测试

在项目根目录执行以下命令。测试依赖安装到临时目录，不改变网站的静态部署方式：

```sh
paijian_test_deps="$(mktemp -d)"
npm install --prefix "$paijian_test_deps" --no-package-lock --no-save @electric-sql/pglite@0.5.15
NODE_PATH="$paijian_test_deps/node_modules" node --test tests/cloudbase-db.test.cjs tests/cloudbase-registration.test.cjs tests/cloudbase-client.test.cjs tests/community-registration.test.cjs
```

数据库测试在 PGlite 的 PostgreSQL 引擎里执行本项目的 SQL，并构造与此环境一致的认证列结构。它验证输入校验、北京时间日期、每天唯一打卡、数据隔离、公开与撤回、环境范围及权限拒绝；注册测试覆盖分钟、小时、北京时间跨日限流窗口、用户名预占和私有表权限。客户端测试使用模拟 SDK 核对注册、密码登录、会话和 RPC 调用；HTTP 注册测试启动本地服务器，使用模拟云端服务检查请求格式、来源限制、密码规则、限流、用户名预占及错误响应。这些测试都不访问真实云端。

安装 Playwright 并准备 Chrome 后，可运行 `node --test tests/cloudbase-auth.browser.cjs tests/community.browser.cjs tests/community-entry.browser.cjs` 检查官方 SDK 请求、登录/注册界面、数据隔离和 GitHub 试用入口。保留的 `tests/community-auth.browser.cjs` 使用独立最小页面测试旧 Supabase 邮箱适配器，与当前账号界面分离。

## 9. 免费试用的期限与访问限制

按 2026-11-09 核对的[官方价格文档](https://cloud.tencent.com/document/product/876/127357)，当前体验环境提供 **3000 资源点/月**，静态托管、认证和数据库等资源共用额度。免费环境不能开启按量付费或加购资源包。每次免费续期为 **6 个月**，需在到期前 **1 个月**内手动续期，不自动续期。环境的实际到期日和剩余额度以控制台为准。

[默认域名访问说明](https://docs.cloudbase.net/service/alias)明确将 `*.tcloudbaseapp.com` 定位为开发测试用途，浏览器访问可能显示平台中间页，需访客点击“确定访问”。平台存在动态访问频率风控，超限可能暂时禁止访问；当前文档没有给出可承诺的固定每日访问次数或 QPS。不要移除或绕过平台中间页。

当前政策取消的是默认域名旧有的硬性有效期限制，并未取消环境本身的套餐到期或资源额度。平台明确要求正式生产或大规模分发使用自定义域名，因此此路径适用于功能试用和验收；正式公开运营需另行确定套餐和域名方案。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 环境列表中的文档数据库为空 | 此环境是 PostgreSQL 模式；核对 PostgreSQL 资源项，不新建文档集合。 |
| 查不到环境 | 核对腾讯云账号、环境 ID 和 `-r ap-shanghai`。 |
| 页面提示尚未启用 | 检查真实服务准备和线上 `community/config.js` 的 `enabled`，准备好后再开启。 |
| GitHub 域名添加失败，`FreePackageDenied` | 当前体验套餐限制；进入已允许的 CloudBase 默认域名试用页，不反复添加或自动升级付费。 |
| 页面提示访问确认或默认域名被限频 | 属于平台默认域名的测试限制，按提示确认或等待恢复；正式运营需配置受支持的自定义域名。 |
| 注册暂不可用 | 检查 `registrationUrl`、HTTP 函数状态、执行角色权限和注册限流 SQL；先查看不含密码的健康检查结果。 |
| 注册提示操作过于频繁 | 等待当前固定窗口结束；每个 IP 和全站均有限额，创建失败也可能占用一次名额。 |
| 注册完成却没有登录 | 页面会保留用户名并回到登录；使用刚设置的密码登录，避免重复创建账号。 |
| 忘记密码 | 当前没有自助找回功能；请妥善保存凭据，不向他人提供密码。 |
| SQL 提示用户 ID 类型不匹配 | 使用 CloudBase 专用 SQL，按真实 `auth.uid()` / JWT `sub` 处理，不能沿用 Supabase 的 UUID 假设。 |
| RPC 不存在或刚更新后未生效 | 确认在同一环境完整应用 SQL，检查函数签名和 PostgREST schema cache；不要放宽表权限。 |
| 浏览器直接读表被拒绝 | 这是预期行为，页面应调用四个社区 RPC。 |
| 管理员能调用，但普通用户失败 | 检查账号状态、所属环境、RPC 身份校验与执行权限，以及是否携带正确登录会话。 |
| `--read-only` 没有阻止 PostgreSQL 写入 | 该选项仅对 MySQL 生效。只读核查用明确的 SELECT 或受限数据库角色。 |
| 免费环境到期或额度不足 | 在控制台查看配额与手动续期规则，按 [官方价格文档](https://cloud.tencent.com/document/product/876/127357) 处理；不自动升级付费。 |

## 官方依据

核对日期：2026-11-09。CLI 命令按 `@cloudbase/cli@3.9.2 --help` 核实；数据库模式和系统列结构以该环境实际查询结果为准。

- [CLI 安装](https://docs.cloudbase.net/cli-v1/install)、[设备码登录](https://docs.cloudbase.net/cli-v1/login)、[环境详情](https://docs.cloudbase.net/cli-v1/envs/detail)。
- [用户名密码登录与注册限制](https://docs.cloudbase.net/authentication-v2/method/username-login)、[创建用户 API](https://cloud.tencent.com/document/api/876/127961)、[HTTP 云函数部署](https://docs.cloudbase.net/cli-v1/functions/deploy)。
- [安全来源](https://docs.cloudbase.net/envconfig/security/intro)、[添加安全域名](https://docs.cloudbase.net/cli-v1/http-gateway/cors/add)。
- [静态托管管理与默认域名](https://docs.cloudbase.net/hosting/manage)、[默认域名访问限制及中间页](https://docs.cloudbase.net/service/alias)、[静态文件部署命令](https://docs.cloudbase.net/cli-v1/hosting/deploy)。
- [PostgreSQL 概述与 ExecutePGSql](https://docs.cloudbase.net/database/postgresql/initialization)、[PG 身份认证](https://docs.cloudbase.net/authentication-v2/auth/auth-pg)、[CLI 执行 SQL](https://docs.cloudbase.net/cli-v1/db/postgresql/execute)。
- [通用云 API 调用](https://docs.cloudbase.net/cli-v1/api)、[官方 SDK 云 API 参数](https://github.com/TencentCloud/tencentcloud-sdk-nodejs/blob/master/src/services/tcb/v20180608/tcb_models.ts)：用于核对用户管理、登录策略和安全域名的自动配置。
