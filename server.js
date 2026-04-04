const express = require('express');
const path = require('path');
const app = express();

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/config', (req, res) => {
  res.json({ token: process.env.DERIV_TOKEN || '' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', bot: 'GOLD BOT XAU/USD', time: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Gold Bot server running on port ${PORT}`);
});
