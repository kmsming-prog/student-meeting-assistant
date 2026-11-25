# 部署與試跑

## 1. 準備自己的帳號

- 建立 LINE 官方帳號並啟用 Messaging API。準備同一個 channel 的 Channel secret 和 Channel access token。先以老師自己的 LINE 帳號加入好友。 [LINE 官方設定指南](https://developers.line.biz/en/docs/messaging-api/getting-started/)
- 在 Google Cloud 啟用 Calendar API 並依組織規則建立專用服務帳戶。請先用獨立測試日曆。主日曆需授予服務帳戶變更活動的權限，其他只用於比對的日曆提供查看有空／忙碌的權限。 [Google Calendar 權限](https://developers.google.com/workspace/calendar/api/concepts/sharing/)
- 參考 `calendar-profile.example.json` 建立自己的 Calendar 設定。使用日曆實際 ID；固定晤談使用實際的 `recurringEventId` 和正確的週幾、開始時間。現行設定格式需有至少一個固定系列。若只打算開放臨時預約，請 AI 先調整空名單的支援並驗證。

## 2. 部署一份獨立的 Worker

從專案根目錄執行以下指令。複製 `wrangler.example.jsonc` 為 `wrangler.jsonc` 後，填入自己的 Worker 名稱、D1 ID，以及 Worker HTTPS 網址加上 `/google/calendar/webhook`。資料表由隨附的 migrations 建立。

```sh
npm test
npx wrangler@4.167.0 login
npx wrangler@4.167.0 d1 create student-meeting-assistant
# 現在填好 wrangler.jsonc
npx wrangler@4.167.0 deploy --dry-run
npx wrangler@4.167.0 d1 migrations apply DB --remote
npx wrangler@4.167.0 deploy
```

在 Worker 的 Variables and Secrets 設定以下 Secrets。

| 名稱 | 內容 |
| --- | --- |
| `LINE_CHANNEL_SECRET` | LINE Channel secret |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Channel access token |
| `GOOGLE_SERVICE_ACCOUNT` | 專用 Google 服務帳戶 JSON 金鑰 |
| `MEETING_PROFILE` | 本人的日曆及固定晤談設定 JSON |
| `ADMIN_TOKEN` | 用 `node scripts/admin.mjs generate-admin-token` 產生 |

LINE Webhook 使用 Worker HTTPS 網址加上 `/line/webhook`。在 LINE 後台執行 Verify，再啟用 Use webhook 和 Webhook redelivery。 [Cloudflare Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/) · [LINE Webhook 指南](https://developers.line.biz/en/docs/messaging-api/receiving-messages/)

## 3. 老師先試跑

從安全的本機環境設定 `RMA_URL` 與 `RMA_ADMIN_TOKEN`，分別指向自己的 Worker HTTPS 網址和管理 Token。以下指令皆使用帳號持有人自己的部署。

```sh
node scripts/admin.mjs preflight
node scripts/admin.mjs invite teacher
```

預檢應可讀取指定日曆，權限為 `writerWithoutPrivateAccess`、`writer` 或 `owner`。將命令顯示的一次性綁定碼，在老師本人與官方帳號的私訊中輸入。再執行以下指令並點選 LINE 中的「確認收到」。

```sh
node scripts/admin.mjs test-line
node scripts/admin.mjs status
node scripts/admin.mjs booking-menu default
```

用測試帳號登記姓名、選取空檔和確認預約。核對日曆寫入、兩人同時選時段時的結果，以及重按確認的結果。測試「以上時間都不行」，確認老師收得到協助通知。

## 4. 確認改期流程後再擴大使用

```sh
node scripts/admin.mjs conflicts-enable
node scripts/admin.mjs conflicts
```

在測試日曆新增一個與既有晤談重疊的忙碌活動。核對學生收到的改期提示、重選後的日曆活動和老師端的結果。測試固定晤談時，核對同一週期的其他日期。兩場學生晤談互撞時由老師處理。可用 `conflicts-pause` 暫停監控。

老師可在 LINE 輸入「待改期」，也可用 `status` 和 `conflicts` 查看管理狀態。主動通知與帳號其他推播共用 LINE 額度，請在開放前確認帳號方案及預估用量。 [LINE Messaging API 訊息計量](https://developers.line.biz/en/docs/messaging-api/pricing/)
