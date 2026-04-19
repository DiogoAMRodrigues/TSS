const createApp = require("./app");

const { app, config } = createApp();

app.listen(config.port, () => {
  console.log(`TSS middleware running on http://localhost:${config.port}`);
});
