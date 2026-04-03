const express = require('express');
const path = require('path');
const app = express();

const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Main route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check for Render
app.get('/health', (req, res) => {
  res.json({ status: 'ok', bot: 'GOLD BOT XAU/USD', time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Gold Bot server running on port ${PORT}`);
});
