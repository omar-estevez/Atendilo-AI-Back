import express from "express";
import cors from "cors";
import { env } from "./config/env.js";
import { router } from "./routes.js";

const app = express();

app.use(
    cors({
        origin: true,
        credentials: true,
    })
);

app.use(express.json());

app.get("/", (_req, res) => {
    res.json({
        name: "Lumora API",
        status: "running",
    });
});

app.use("/api", router);

app.listen(env.PORT, () => {
    console.log(`Lumora API running on port ${env.PORT}`);
});