# Parent Control Relay Server

Այս սերվերը պետք է լինի ինտերնետում հասանելի VPS/hosting-ի վրա։

## Environment variables

```text
PORT=8080
AGENT_TOKEN=CHANGE_AGENT_TOKEN
VIEWER_PASSWORD=CHANGE_VIEWER_PASSWORD
BOT_TOKEN=TELEGRAM_BOT_TOKEN
ADMIN_CHAT_ID=PARENT_TELEGRAM_CHAT_ID
```

`AGENT_TOKEN`-ը նույնն է, ինչ տան համակարգչի `config.ini` ֆայլում։
`VIEWER_PASSWORD`-ը ծնողի մուտքի գաղտնաբառն է վեբ-պանելի համար։

## Run

```powershell
npm install
npm start
```

Պանելը բացվում է՝

```text
https://your-server-url
```
