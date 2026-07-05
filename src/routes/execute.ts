import type { Application } from "express";
import type { TunnelServices } from "../types.js";

export function mountExecuteRoute(app: Application, services: TunnelServices): void {
  const { wireClient } = services;

  app.post("/api/execute", async (req, res) => {
    const { prompt, timeout_ms, include_thinking } = req.body;

    if (!prompt || typeof prompt !== "string") {
      res.status(400).json({ error: "Missing or invalid 'prompt' field" });
      return;
    }

    if (!wireClient.isConnected()) {
      res.status(503).json({
        error: "Wire client not connected",
        hint: "Start Kimi server: kimi web --no-open. Set KIMI_SERVER_TOKEN if needed.",
      });
      return;
    }

    try {
      const response = await wireClient.sendPrompt(prompt, {
        timeoutMs: timeout_ms || 300000,
        includeThinking: include_thinking || false,
      });

      res.json({
        success: true,
        promptId: response.promptId,
        status: response.status,
        response: response.finalText,
        thinkingAvailable: response.thinkingText.length > 0,
        messageCount: response.messages.length,
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: (err as Error).message,
      });
    }
  });
}
