# 拍间社区接入腾讯云 CloudBase PostgreSQL

本项目使用已创建的上海地域环境。节拍器与曲谱工具继续由 GitHub Pages 发布；社区试用页面放在 CloudBase 已允许的默认域名下，GitHub 社区页提供“打开打卡试用版”按钮，由用户点击进入。CloudBase 提供邮箱验证码认证与 PostgreSQL 数据库，网页通过官方 SDK 调用数据库 RPC 完成打卡、动态和排行榜。

| 项目 | 实际配置 |
| --- | --- |
| 环境 ID | `fast-junglefowl-d3fqxnq941dd1c4e` |
| 地域 | 上海，`ap-shanghai` |
| 数据库模式 | **PostgreSQL**，`DocumentExt: false` |
| 云端实例 | `postgres-kkeugpri`，共享实例 |
| 网站 | `https://line-ar-line.github.io/paijian-metronome/` |
| 社区试用页 | `https://fast-junglefowl-d3fqxnq941dd1c4e-1528285429.tcloudbaseapp.com/paijian/community.html` |
| 已允许的 Web 安全域名 | `fast-junglefowl-d3fqxnq941dd1c4e-1528285429.tcloudbaseapp.com` |
| 当前套餐 | 免费体验版，`baas_trial` |

以上数据库模式已按云端实际配置核对。本环境使用 SQL 表、GRANT 和 RLS 权限，初始化入口是本文的 SQL 文件。

当前免费套餐添加 GitHub 域名时，`CreateAuthDomain` 实际返回 `OperationDenied.FreePackageDenied`。因此先用默认域名完成试用，不升级付费。默认域名是开发测试入口，有访问提示中间页和频率限制；它不构成正式社区的长期免费托管承诺。具体限制见本文第 9 节。

截至 2026-11-09，邮箱登录及内置代发已在云端开启，CloudBase SQL 已应用成功，两张业务表的 RLS 与直接访问权限已回读核对。试用页面的 10 个文件已上传并通过 CLI 校验，确认访问后的电脑与手机页面已实测正常加载。**真实邮件送达和双邮箱登录打卡仍待验收**。GitHub 域名直接使用社区服务仍受体验套餐安全域名限制，默认域名试用不代表这一限制已解决。

环境 ID 和地域可公开写入网页。腾讯云 SecretId、SecretKey、CLI 登录凭据、管理员 API Key、邮箱密码和验证码都不需要发送给协作者，也不能写进网页。

## 1. 授权 CLI 并确认环境

命令已按官方 **CloudBase CLI 3.9.2** 帮助核对。需要 Node.js 18 或更新版本，在项目根目录执行：

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

## 2. 启用邮箱验证码和内置邮件代发

1. 打开 [CloudBase 控制台](https://tcb.cloud.tencent.com/dev)，选择上面的环境。
2. 进入 **身份认证 → 登录方式**，找到 **邮箱验证码**。
3. 点击 **配置发件邮箱**，选择 **开启邮件代发**，保存。
4. 确认邮箱登录处于启用状态。需要开放新用户注册时，保持相应注册能力开放。

CloudBase 内置代发不需要第三方 SMTP 或自有发信域名。以后需要自定义发件人时，可按 [官方邮箱登录文档](https://docs.cloudbase.net/authentication-v2/method/email-login) 配置自定义 SMTP。验证码发送仍受平台频率与资源限制，内置代发不代表无限免费邮件。

官方流程使用 6 位邮箱验证码，以实际邮件为准。用户输入验证码并通过服务端验证后才建立会话；单纯点击“发送”不会登录。本项目使用 CloudBase 认证，不需要改 Supabase 的邮件模板。

管理员自动配置时，官方云 API 提供 `GetProviders`、`ModifyProvider`。`email` 身份源顶层 `On: "TRUE"` 表示启用；`EmailConfig.On: "TRUE"` 表示平台代发。查询结果可能含第三方或 SMTP 配置，检查时仅展示身份源 ID、类型和启用状态，不公开完整配置。

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

CloudBase 的 `auth.uid()` 返回文本，实际身份来自登录 JWT 中的 `sub`。本环境的 `auth.users.id` 是内部 `bigint`，`sub` 和 `project` 是文本列，`email_verified` 是布尔列。SQL 从可信登录身份及所属环境找到唯一、已验证邮箱的用户，再关联内部数字主键；网页不传入内部主键来决定数据归属。

初始化会创建：

| 对象 | 用途 |
| --- | --- |
| `public.community_profiles` | 用户公开昵称 |
| `public.community_checkins` | 用户自己的每日打卡、时长、曲目、心得和公开状态 |
| `community_private` 下的辅助函数 | 日期、输入校验与已验证邮箱身份检查 |
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

本项目不给普通网页客户端直接访问业务表的权限。两张表启用 RLS，并撤销匿名和登录角色的表级直接读写；允许的操作都经四个 RPC 完成。每个 RPC 再从可信登录身份检查用户及已验证邮箱，不能接受前端传入用户 ID 来决定数据归属。

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

[cloudbase/verify.sql](../cloudbase/verify.sql) 提供单条 `DO` 核查：16 次无效身份 RPC 均须拒绝、13 项 ACL 断言、两表 RLS 与四个函数的固定搜索路径；已在实际环境执行通过，未新增测试账号或打卡。可按初始化文件的整文件方式执行。

看到函数存在只是结构检查，还需做后面的真实账户验收。管理员 SQL 通道会绕过普通用户的部分权限，管理员能查询数据并不能证明网站用户权限正确。

## 6. 启用社区试用页并发布

部署准备期间，[community/config.js](../community/config.js) 使用：

```js
window.PAIJIAN_COMMUNITY_CONFIG = {
  provider: 'cloudbase',
  envId: 'fast-junglefowl-d3fqxnq941dd1c4e',
  region: 'ap-shanghai',
  enabled: false,
};
```

确认 SQL、权限、默认域名和邮箱代发都配置完成后，才将 `enabled` 改为 `true`。网页使用用户登录后由 SDK 管理的会话调用 `app.rdb().rpc(...)`，无需在前端配置 `service_role` 管理密钥，也无需 `functionName`。

在项目根目录使用 `tools/build-community-hosting.cjs` 创建一个新的发布目录。脚本只打包社区 HTML、样式、`community/` 客户端文件以及两个本地 SDK；入口脚本处理域名入口及返回 GitHub 工具页的导航。然后上传到 `/paijian/` 子目录：

```sh
paijian_publish_root="$(mktemp -d)"
node tools/build-community-hosting.cjs --output "$paijian_publish_root/site"
tcb hosting deploy "$paijian_publish_root/site" paijian -e fast-junglefowl-d3fqxnq941dd1c4e -r ap-shanghai --entry community.html --verify --json
```

`hosting deploy` 只上传准备好的文件，不执行构建。只上传上述脚本生成的社区目录，不上传整个仓库。命令中的云端前缀写为 `paijian`（不加前导斜杠，避免 CLI 3.9.2 的校验路径不匹配）；实际访问路径为 `/paijian/`。不使用 `--prune`，保留云端根目录已有的系统认证文件。先确认社区试用 URL 可访问、静态资源加载正确，再发布 GitHub 上指向该 URL 的入口。

随后提交并推送到现有 GitHub 仓库，保持 **GitHub Pages → main / (root)**。CloudBase 文件上传、数据库初始化和 GitHub Pages 发布是独立步骤：推送 GitHub 不会自动更新 CloudBase 文件或应用 SQL。

## 7. 用两个邮箱完成真实验收

本地模拟测试能检查页面、认证适配和数据库逻辑，但不会发送真实邮件，不能替代云端权限验收。使用两只自己能收信的邮箱，在普通窗口和无痕窗口分别操作：

1. A 发送验证码，确认收到邮件；错误验证码不能登录，正确验证码验证后才能进入账号。
2. A 保存昵称，提交默认私密打卡。刷新、退出再登录后，个人记录与统计仍存在。
3. A 同一天再次提交不能生成第二条记录或重复累计分钟数；另一设备提交也应保留已有记录。
4. B 登录后看不到 A 的私密记录，无法修改 A 的记录。
5. A 分享打卡后，B 刷新可见动态及其周榜贡献；A 取消分享后，B 刷新不再看到这些公开内容，A 自己的累计不减少。
6. 公开动态使用昵称，不泄露登录邮箱。退出登录后页面清空私人记录；切换账户不会显示前一个账户的统计。
7. 普通用户直接访问两张业务表应被拒绝；四个 RPC 中本人允许的操作成功。匿名、未验证邮箱以及伪造用户 ID 不能取得私人数据或写入。
8. 手机通过 GitHub 的入口进入社区试用页，按平台提示确认访问后，完成登录、打卡和查看动态。节拍器等 GitHub Pages 页面入口仍受当地网络影响。

上线记录应区分“模拟测试通过”“SQL 应用成功”“真实邮件送达”“双账户权限验收通过”。没有进行真实邮件或双账户验证时，应明确标为待验收。

## 8. 本地复现数据库与客户端测试

在项目根目录执行以下命令。测试依赖安装到临时目录，不改变网站的静态部署方式：

```sh
paijian_test_deps="$(mktemp -d)"
npm install --prefix "$paijian_test_deps" --no-package-lock --no-save @electric-sql/pglite@0.5.15
NODE_PATH="$paijian_test_deps/node_modules" node --test tests/cloudbase-db.test.cjs tests/cloudbase-client.test.cjs
```

数据库测试在 PGlite 的 PostgreSQL 引擎里执行本项目的 SQL，并构造与此环境一致的认证列结构。它验证输入校验、北京时间日期、每天唯一打卡、数据隔离、公开与撤回、环境范围及权限拒绝。客户端测试使用模拟 SDK 核对会话、验证码和 RPC 调用；两者都不访问真实云端、不会发送邮件。

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
| 无法发送验证码 | 检查邮箱登录、内置代发、垃圾箱和平台限流；不要反复点击发送。 |
| SQL 提示用户 ID 类型不匹配 | 使用 CloudBase 专用 SQL，按真实 `auth.uid()` / JWT `sub` 处理，不能沿用 Supabase 的 UUID 假设。 |
| RPC 不存在或刚更新后未生效 | 确认在同一环境完整应用 SQL，检查函数签名和 PostgREST schema cache；不要放宽表权限。 |
| 浏览器直接读表被拒绝 | 这是预期行为，页面应调用四个社区 RPC。 |
| 管理员能调用，但普通用户失败 | 检查用户邮箱是否已验证、RPC 身份校验与执行权限、是否携带正确登录会话。 |
| `--read-only` 没有阻止 PostgreSQL 写入 | 该选项仅对 MySQL 生效。只读核查用明确的 SELECT 或受限数据库角色。 |
| 免费环境到期或额度不足 | 在控制台查看配额与手动续期规则，按 [官方价格文档](https://cloud.tencent.com/document/product/876/127357) 处理；不自动升级付费。 |

## 官方依据

核对日期：2026-11-09。CLI 命令按 `@cloudbase/cli@3.9.2 --help` 核实；数据库模式和系统列结构以该环境实际查询结果为准。

- [CLI 安装](https://docs.cloudbase.net/cli-v1/install)、[设备码登录](https://docs.cloudbase.net/cli-v1/login)、[环境详情](https://docs.cloudbase.net/cli-v1/envs/detail)。
- [邮箱验证码登录](https://docs.cloudbase.net/authentication-v2/method/email-login)、[添加安全域名](https://docs.cloudbase.net/cli-v1/http-gateway/cors/add)。
- [静态托管管理与默认域名](https://docs.cloudbase.net/hosting/manage)、[默认域名访问限制及中间页](https://docs.cloudbase.net/service/alias)、[静态文件部署命令](https://docs.cloudbase.net/cli-v1/hosting/deploy)。
- [PostgreSQL 概述与 ExecutePGSql](https://docs.cloudbase.net/database/postgresql/initialization)、[PG 身份认证](https://docs.cloudbase.net/authentication-v2/auth/auth-pg)、[CLI 执行 SQL](https://docs.cloudbase.net/cli-v1/db/postgresql/execute)。
- [通用云 API 调用](https://docs.cloudbase.net/cli-v1/api)、[官方 SDK 云 API 参数](https://github.com/TencentCloud/tencentcloud-sdk-nodejs/blob/master/src/services/tcb/v20180608/tcb_models.ts)：用于核对邮箱身份源、平台代发和安全域名的自动配置。
