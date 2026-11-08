# 开通拍间练习社区：邮箱登录、每日打卡与动态

网页继续由 GitHub Pages 发布；Supabase 负责验证邮箱和保存账户、打卡记录。首次输入邮箱、收到验证码并验证后会创建账户，以后用同一邮箱登录即可。节拍器和曲谱工具仍可直接使用。

需要准备：一个 Supabase 账户、一个免费项目、可向普通用户发信的 SMTP 服务，以及两只自己能收信的邮箱。配置 SMTP 时通常还需要一个自己能管理 DNS 的域名；网站本身可以继续使用现有的 GitHub Pages 地址。

按下面顺序操作。Supabase 控制台会调整菜单名称；找不到时，可使用文中的官方页面链接，再选择自己的项目。

## 1. 注册 Supabase 并创建免费项目

1. 打开 [Supabase 控制台](https://supabase.com/dashboard)，注册或使用 GitHub 账户登录。
2. 创建 Organization（组织），套餐选择 **Free**。
3. 点击 **New project**，选择刚创建的组织；名称可填 `paijian-community`。
4. 设置并自行保存数据库密码，选择适合访问地区的 Region，然后创建项目，等待初始化完成。
5. 打开项目，确认数据库和 API 已就绪。暂时不用安装命令行、服务器或 Supabase CLI。

免费计划适合起步，但数据库容量、流量、活跃用户、闲置项目暂停规则以及邮件服务额度分别计算。以 [Supabase 当前价格页](https://supabase.com/pricing)、项目 **Usage / Billing** 和邮件服务商的套餐页面为准；免费数据库不等于无限免费邮件。

## 2. 一次性创建数据库表和权限

1. 在本仓库打开 [supabase/schema.sql](../supabase/schema.sql)，复制文件的**全部内容**。
2. 在刚创建的 Supabase 项目进入 **SQL Editor → New query**。
3. 粘贴全部 SQL，点击 **Run**。等到执行成功；若出现错误，保留完整错误信息，先排除问题再继续。
4. 在 **Table Editor** 检查社区相关表已经出现。

这份 SQL 一起安装数据表、每天一条记录的约束、数据库函数和行级权限（RLS）。只手动建表或只复制前半段会导致登录后无法读写。使用本项目的完整脚本，不需要关闭 RLS，也不需要开放所有表给匿名用户。

建议在新项目执行初始化。已有其他业务数据的项目，应先核对脚本涉及的表和函数再执行；后续更新使用仓库说明中的迁移步骤。

## 3. 启用邮箱登录及自动注册

打开 **Authentication → Sign In / Providers**：

1. 找到 **Email**，保持 **Enable Email provider** 开启。
2. 保持 **Confirm email** 开启，确保新账户必须验证邮箱。
3. 在用户注册设置中开启 **Allow new users to sign up**；否则已有用户可以登录，新朋友无法注册。
4. 查看 **Email OTP expiration**（验证码有效期）。可以设置为 `600` 秒，即 10 分钟；之后发送的验证码按该项目设置过期。
5. 如果有 **Email OTP length**，记录当前位数。官方指南展示 6 位验证码，项目也可配置为 8 位等长度；拍间输入框接受 **6–10 位数字**，按实际收到的完整验证码输入，不补零、不截断。

拍间调用 `signInWithOtp` 发送验证码，并用 `verifyOtp({ email, token, type: 'email' })` 验证。新邮箱允许自动创建账户，因此不用在控制台逐个添加用户，也不需要让朋友成为 Supabase 项目团队成员。

## 4. 把两种邮件模板都改成数字验证码

打开 **Authentication → Email → Templates**，或 [Email Templates](https://supabase.com/dashboard/project/_/auth/templates)。分别编辑并保存：

1. **Confirm sign up**：首次注册的确认邮件。
2. **Magic Link / Magic link or OTP**：已有账户再次登录的邮件。

两种模板都可使用下面的主题与正文。只改 Magic Link 可能导致第一次注册仍收到链接；只改 Confirm sign up 则可能导致第二次登录收到链接。

主题：`拍间登录验证码`

正文：

```html
<h2>拍间登录验证码</h2>
<p>请回到拍间练习社区，输入以下验证码：</p>
<p style="font-size: 30px; font-weight: bold; letter-spacing: 6px;">{{ .Token }}</p>
<p>验证码会在短时间内过期，请使用最新收到的一封邮件中的验证码。</p>
<p>如果你没有申请登录，可以忽略这封邮件。</p>
```

必须保留 `{{ .Token }}`，包括大括号和点。不要填固定数字，不要把它换成 `{{ .TokenHash }}`；当前页面让用户输入数字验证码，因此不要继续只发 `{{ .ConfirmationURL }}` 登录链接。模板预览成功不代表邮件服务已经可以向其他用户发信，下一步仍需配置。

## 5. 配置能向朋友发信的自定义 SMTP

**这是公开使用的必要步骤。Supabase 自带的默认邮件服务只向项目团队成员的邮箱发信，且发送频率很低。只用自己的管理员邮箱测试成功，不能证明朋友能登录。**

1. 选择支持 SMTP 的事务邮件服务，例如 [Resend](https://resend.com/docs/send-with-supabase-smtp)、[Brevo](https://help.brevo.com/hc/en-us/articles/7924908994450-Send-transactional-emails-using-Brevo-SMTP) 或其他 [Supabase 官方列出的服务](https://supabase.com/docs/guides/auth/auth-smtp)。创建邮件服务账户。
2. 按服务商要求添加并验证发信域名，例如 `mail.example.com`，将服务商提供的 DNS 记录添加到自己的域名管理后台，等待验证成功；按其说明配置 SPF、DKIM、DMARC。邮件服务若处于 sandbox / test 模式，还要按要求申请正式发信或移除收件人限制。
3. 设置发件地址，例如 `login@mail.example.com`，以及发件人名称 `拍间`。地址必须属于服务商允许的、已验证的发信身份。
4. 从服务商的 **SMTP** 页面取得 Host、Port、Username、Password。某些服务商把 API key 作为 SMTP Password，按该服务商说明填写；不要把 Supabase API key 当成 SMTP 密码。
5. 回到 Supabase，打开 **Authentication → Email → SMTP Settings** 或 [Custom SMTP](https://supabase.com/dashboard/project/_/auth/smtp)，开启自定义 SMTP，填写发件地址、名称和上述四项 SMTP 信息，保存。
6. 打开 **Authentication → Rate Limits**，检查发信上限和验证码重发间隔；同时检查邮件服务商的每日/月度额度。Supabase 官方当前说明自定义 SMTP 初始为 30 封/小时，可在控制台调整，以项目实际值为准。提高 Supabase 限额不会提高邮件服务商自身额度。

SMTP 密码/API key 只保存到 Supabase 控制台，**不要写进 `community/config.js`、GitHub 仓库或发给协作者**。没有自己的发信域名时，可以先用默认服务测试项目团队邮箱；要面向朋友开放，仍需完成服务商要求的发信身份验证。GitHub 提供的 `line-ar-line.github.io` 并不是你能管理 DNS 的邮件域名，不能拿它完成这项验证。

## 6. 配置网站地址

打开 **Authentication → URL Configuration**：

**Site URL** 填现有网站完整地址，包含项目路径和末尾斜杠：

```text
https://line-ar-line.github.io/paijian-metronome/
```

**Redirect URLs** 添加实际社区页面：

```text
https://line-ar-line.github.io/paijian-metronome/community.html
```

本地调试需要时，再添加：

```text
http://127.0.0.1:8765/community.html
```

如果 Fork 到自己的 GitHub 账户、修改仓库名或绑定了自定义域名，使用 **GitHub 仓库 Settings → Pages** 显示的真实网址，替换上面两个线上地址。公开站点使用精确地址，无需添加所有域名的通配符。

本项目的数字验证码在当前页面完成验证，不依赖点击邮件跳转；这些地址仍应保持正确，以免其他确认邮件或后续认证功能跳回默认的 `localhost:3000`。`Site URL` 不能替代 SMTP 配置。

## 7. 复制项目 URL 和公开密钥

1. 在 Supabase 项目点击顶部 **Connect**，复制 **Project URL**，形式为 `https://你的项目编号.supabase.co`。这是 API 地址，不是 `supabase.com/dashboard/...` 控制台网址。
2. 进入 **Settings → API Keys**，复制 **Publishable key**，通常以 `sb_publishable_` 开头。若项目仍使用旧版密钥，也可使用 **anon / public** key。
3. 打开 [community/config.js](../community/config.js)，填写：

```js
window.PAIJIAN_COMMUNITY_CONFIG = {
  supabaseUrl: 'https://你的项目编号.supabase.co',
  supabasePublishableKey: 'sb_publishable_你的公开密钥',
};
```

两个值必须来自**同一个项目**。使用旧版 `anon` key 时也填入 `supabasePublishableKey` 字段。

公开密钥会随静态网页被浏览器读取，这是预期用法；真实数据访问权限由 SQL 中的 RLS 和数据库函数控制。不要填 **Secret key**（`sb_secret_...`）、**service_role**、数据库密码、SMTP 密码或个人访问令牌。这些不应进入网页或公开仓库。

需要协助填写和更新网页时，只需提供这两个公开值：

```text
Project URL：https://……supabase.co
Publishable key：sb_publishable_……
```

账号注册、SQL 执行、SMTP 配置和邮箱验证码验证仍在你自己的账户中完成；不需要向协作者发送密码或登录验证码。

## 8. 更新 GitHub Pages

保存配置后，将本次社区页面、脚本和 `community/config.js` 一起提交并推送到现有 GitHub 仓库的 `main` 分支。项目继续使用 **Settings → Pages → Deploy from a branch → main / (root)**，无需增加 npm 构建、服务器或 CI 构建步骤。

等 GitHub Pages 发布完成，打开：

[拍间练习社区](https://line-ar-line.github.io/paijian-metronome/community.html)

如果刚更新仍提示未配置，强制刷新一次，确认线上 `community/config.js` 已包含正确项目 URL 和公开密钥。GitHub Pages 负责网页发布；邮件和数据由刚配置的 Supabase 项目提供。

## 9. 用两个真实邮箱完成验收

至少有一只测试邮箱**不是 Supabase 项目团队成员**。两个账户分别使用普通窗口和无痕窗口，避免共享登录状态。自动化测试使用模拟接口，不会发送邮件；以下步骤才能验证真实发信和真实跨账户权限。

1. **邮箱 A 首次注册**：输入 A，发送验证码；确认收到数字验证码，输入后进入自己的账户。错误验证码不能登录；不要反复尝试以免触发限流。
2. **再次登录**：A 退出后重新发送验证码并登录，验证 Magic Link / OTP 模板也已经正确。成功登录后刷新页面，账户应能恢复。
3. **保存昵称、今日打卡**：A 设置昵称，提交一条带分钟数、曲目和感想的练习记录。查看个人统计、日历和历史；重复提交同一天不能生成第二条或重复累计。
4. **邮箱 B 注册**：在无痕窗口用不属于项目团队的 B 完成注册。如果收不到验证码，先检查 SMTP 限制，不要通过把 B 加入项目团队来掩盖问题。
5. **检查公开范围**：A 发布公开打卡，B 刷新后应能看到动态及对应公开排名信息。公开内容使用昵称，不应暴露 A 的邮箱。
6. **检查私密记录**：A 将自己的打卡设为私密，B 刷新后不应再看到该条动态或该条私密记录贡献的公开排名数据；A 自己仍能看到个人记录和统计。再改为公开，确认可恢复展示。
7. **检查账户隔离**：B 的个人历史和统计不能包含 A 的私密记录；B 无法编辑 A 的记录。退出后不应继续显示前一账户的私密统计或可操作表单。
8. **检查手机页面**：用手机打开线上地址，完成一次登录和查看记录，确认表单、动态、排行榜没有横向溢出。

如果操作失败，记录报错文字和发生时间，在 **Supabase → Authentication → Logs**、项目 **Logs** 及邮件服务商的发送记录中查看原因。不要把成功的“发送请求”或单纯显示一个登录面板当作邮件已送达、用户已验证。

## 常见问题

| 现象 | 检查位置与处理 |
| --- | --- |
| 自己能收信，朋友提示 `Email address not authorized` | 默认 SMTP 仅允许项目团队邮箱；完成第 5 步自定义 SMTP，并确认服务商已解除测试收件人限制。 |
| 邮件里只有链接，没有数字 | 两种模板均检查，正文必须包含 `{{ .Token }}`；首次注册看 Confirm sign up，再次登录看 Magic Link / OTP。 |
| 收到 8 位码，却以为只能填 6 位 | 按邮件中的完整验证码输入；页面支持 6–10 位。不要修改邮件内容或截取前 6 位。 |
| `Email rate limit exceeded` / HTTP 429 | 等待重发间隔和额度恢复；同时检查 Supabase Rate Limits 与 SMTP 服务商限额，不连续点发送。 |
| 发送成功但长时间没收到邮件 | 查垃圾箱、邮件服务商日志、发信域名验证和账号审核状态；Supabase 请求成功不等于邮箱已投递。 |
| 验证码过期或无效 | 确认邮箱未切换、完整复制最新验证码；在项目有效期内验证，必要时等待后重新申请。 |
| 只能旧用户登录，不能注册 | 检查 Allow new users to sign up、Email provider、Confirm sign up 模板及 SMTP。 |
| 登录后出现“表/函数不存在”或权限错误 | 确认第 2 步 SQL 全部成功执行，URL/key 和执行 SQL 的项目一致；不要通过关闭 RLS 解决。 |
| 页面一直提示未配置 / Invalid API key | 核对线上 config.js、同项目的 URL 与 publishable/anon key、GitHub Pages 是否发布完成。 |
| Supabase 免费项目暂停后无法使用社区 | 在控制台恢复项目并等服务就绪；检查当前免费套餐规则。节拍器与本地曲谱工具仍可使用。 |

## 官方依据

文档依据核对日期：2026-11-09。控制台与套餐可能更新，实际项目设置优先；这里没有承诺任何邮件服务的永久免费额度。

- [Supabase 邮箱免密码登录与 OTP](https://supabase.com/docs/guides/auth/auth-email-passwordless)：发送、自动注册和 `type: 'email'` 验证。
- [Supabase 邮件模板](https://supabase.com/docs/guides/auth/auth-email-templates)：Confirm sign up、Magic Link / OTP、`{{ .Token }}`。
- [Supabase 自定义 SMTP](https://supabase.com/docs/guides/auth/auth-smtp)：默认服务仅向项目团队发信，以及自定义 SMTP 配置。
- [Supabase Auth 限流](https://supabase.com/docs/guides/auth/rate-limits)：发送及验证限额。
- [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys)：公开密钥、旧版 anon 和服务端高权限密钥的区别。
- [Supabase Redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)：Site URL 与允许回跳地址。
- [Supabase Auth OTP 长度配置](https://github.com/supabase/auth/blob/master/internal/conf/configuration.go)：默认回退 6 位、允许 6–10 位；托管项目以其设置为准。
