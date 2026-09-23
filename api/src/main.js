const { createApp } = require("./app");

const PORT = process.env.PORT || 4000;
const app = createApp();

app.listen(PORT, () => {
  console.log(`Dhaka Tesla Pool API listening on :${PORT}`);
});
