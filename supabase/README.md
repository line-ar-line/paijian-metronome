# 练习社区数据库

社区使用 Supabase Auth 处理邮箱验证码，PostgreSQL 保存昵称与打卡。GitHub Pages 负责网页，Supabase 负责账号和共享数据。此目录提供部署代码，仓库不包含已配置的项目、账号或示例社区数据。

## 连接一个 Supabase 项目

1. 创建 Supabase 项目，在项目的 SQL Editor 中以管理员身份执行本目录的 `schema.sql`。整份脚本在一个事务中执行；可以重复运行，已有打卡不会删除。
2. 在 Authentication 中启用 Email 登录，允许新用户注册。将 Site URL 设为网站的实际 HTTPS 地址。
3. 将邮箱登录相关邮件模板改成展示数字验证码，例如 `你的拍间登录验证码是：{{ .Token }}`。检查 Magic Link 和 Confirm Signup 模板，确保新用户及已有用户收到的邮件都包含数字验证码；页面使用 `verifyOtp({ type: 'email' })` 验证，不依赖邮件链接跳转。
4. 为向公众开放的网站配置自己的 SMTP 邮件服务。Supabase 内置发信服务适用于受限测试，发送对象和频率有限；在项目中检查当前限制，并用一个新邮箱和一个已有账号分别验证邮件送达、验证码过期及重发行为。
5. 在 `community/config.js` 填入项目地址和 **publishable key**（或旧版 **anon key**）：

   ```js
   window.PAIJIAN_COMMUNITY_CONFIG = {
     supabaseUrl: 'https://你的项目标识.supabase.co',
     supabasePublishableKey: 'sb_publishable_你的公开密钥'
   };
   ```

   这些配置随网页公开是正常的。不要填写 `service_role`、`sb_secret_...`、数据库密码或任何用户的 access token。网页仅能通过经过身份验证的 RPC 写入自己的记录。
6. 部署网页后，用两个测试邮箱验收：登录、退出、改昵称、私密打卡、公开打卡、修改公开状态、刷新页面，以及不同账号之间的数据隔离。浏览器必须能连接该 Supabase 项目。

项目未配置时，页面会显示未连接服务；不会伪造登录、发送验证码、同步记录或生成虚假的动态和排行榜。

## 规则与接口

- 日期统一按服务器的 `Asia/Shanghai` 时区计算，客户端不能指定打卡日期。每天每账号一条记录，时长为 1–720 的整数分钟。
- 同日重试返回原记录并附带 `created: false`，不修改时长、曲目、心得、可见性或创建时间。首次创建为 `created: true`。
- 昵称为 2–24 个字符，不能包含 `@`、控制字符或仅由空白/不可见字符组成。默认昵称由账号标识生成，不使用邮箱。
- 曲目与心得可为空，分别最多 100 和 280 个字符。心得支持普通换行与制表符。
- 个人累计天数、分钟数及连续天数包含私密记录。今天尚未打卡时，连续天数可从昨天起算；昨天也未打卡则为 0。
- 个人历史显示最近 90 个上海自然日，累计统计保留更早记录。动态最多 30 条，仅包含公开记录，按创建时间从新到旧排列。
- 本周榜单按上海时间周一至周日计算，只统计公开记录；先按打卡天数、再按练习分钟降序排序，最多 20 人。同分时按账号标识稳定排序，不公开该标识。榜单采用顺序名次。
- 改为私密后，该记录不再进入后续动态和榜单查询；他人先前已经看到或保存的内容不会被远程撤回。

四个 RPC 都只授予 `authenticated` 执行权限，并在函数内部检查 `auth.uid()`：

| RPC | 参数 | 返回 |
| --- | --- | --- |
| `community_dashboard()` | 无 | `{ today, week_start, profile, stats, checkins, feed, leaderboard }` |
| `community_update_profile()` | `p_nickname text` | `{ nickname }` |
| `community_check_in()` | `p_minutes integer, p_piece text, p_note text, p_is_public boolean` | 单条打卡字段及 `created` |
| `community_set_checkin_public()` | `p_day date, p_is_public boolean` | 更新后的单条打卡字段 |

单条打卡字段为 `{ day, minutes, piece, note, is_public, created_at }`。所有日期为 `YYYY-MM-DD`；`created_at` 带时区，可用 JavaScript `Date` 解析。业务错误码为 `42501`（未登录）、`22023`（输入无效）及 `P0002`（本人没有该日记录）。RPC 参数转换错误可能由 PostgreSQL 返回 `22P02`。

表启用 RLS，登录者仅可直接读取自己的行；客户端没有直接 INSERT、UPDATE、DELETE 权限。四个 RPC 使用固定空 `search_path` 的 `security definer`，只通过全限定表名操作数据。公共查询逐字段构造 JSON，不包含邮箱或账号 UUID。私有辅助函数不可由客户端调用。删除 Supabase Auth 中的账号会级联删除其昵称和打卡。

## 离线验证 SQL

`tests/community-db.test.cjs` 使用 PGlite 0.5.15 执行真实 PostgreSQL SQL，并在内存中模拟 Supabase 的 `auth.users`、`auth.uid()` 与数据库角色。测试不会访问真实账号或发送邮件。

在项目根目录，用临时目录安装测试依赖，然后运行：

```sh
community_test_dir=$(mktemp -d)
npm install --prefix "$community_test_dir" --no-package-lock --ignore-scripts @electric-sql/pglite@0.5.15
NODE_PATH="$community_test_dir/node_modules" node --test tests/community-db.test.cjs
```

测试覆盖权限隔离、匿名拒绝、输入边界、上海跨日、重复提交、可见性、周榜与动态的排序及上限、连续打卡、历史窗口、脚本重复执行和账号删除。它验证数据库规则，不能代替真实 Supabase 项目的邮件送达、Auth 配置及网页端到端验收。
