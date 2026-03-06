import "dotenv/config";
import app from "./app.js";

const PORT = process.env.PORT || 4000;

async function start() {
  app.listen(PORT, () => {
    console.log(`DocNine running locally at http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
