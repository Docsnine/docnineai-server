import "dotenv/config";
import app from "./app.js";
import { connectDB } from "./config/db.js";
import { startBillingCron } from "./services/cron.service.js";
import { loadServices } from "./api/router.js";

const PORT = process.env.PORT || 4000;

async function start() {
  await connectDB();
  await loadServices();
  startBillingCron();
  app.listen(PORT, () => {
    console.log(`DocNine running locally at http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
