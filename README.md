# GOLD BOT — XAU/USD Deriv

Bot de trading automatique sur l'or (XAU/USD) via l'API Deriv.

## Structure
```
gold-bot-server/
├── server.js        ← serveur Node.js
├── package.json     ← dépendances
└── public/
    └── index.html   ← l'app du bot
```

## Déployer sur Render.com

1. Upload ce dossier sur GitHub
2. Connecte GitHub à Render
3. New Web Service → Build: `npm install` → Start: `npm start`
4. Ouvre l'URL Render → connecte ton token Deriv → active le bot
