import type { Application } from "express";
import type { TunnelServices } from "../types.js";

export function mountStatusRoute(app: Application, services: TunnelServices): void {
  const { messageQueue, wireClient } = services;

  app.get("/api/status", (_req, res) => {
    res.json({
      ...messageQueue.getStatus(),
      wireConnected: wireClient.isConnected(),
      version: "2.0.0",
    });
  });
}
