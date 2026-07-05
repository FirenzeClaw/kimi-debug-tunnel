import type { Application } from "express";
import type { TunnelServices } from "../types.js";

export function mountSendRoute(app: Application, services: TunnelServices): void {
  const { wireClient } = services;

  app.post("/api/send", async (req, res) => {
    const { content, sessionId } = req.body;

    if (!content || typeof content !== "string") {
      res.status(400).json({ error: "Missing or invalid 'content' field" });
      return;
    }

    if (!wireClient.isConnected()) {
      res.status(503).json({
        error: "Wire client not connected",
        hint: "Start Kimi server: kimi web --no-open. Set KIMI_SERVER_TOKEN if needed.",
      });
      return;
    }

    if (sessionId) {
      wireClient.setSessionId(sessionId);
    }

    try {
      const response = await wireClient.sendPrompt(content);
      res.json({
        success: true,
        promptId: response.promptId,
        response: response.finalText,
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: (err as Error).message,
      });
    }
  });
}
