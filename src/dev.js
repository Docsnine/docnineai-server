import app from "./app.js";

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`DocNine running locally at http://localhost:${PORT}`);
});