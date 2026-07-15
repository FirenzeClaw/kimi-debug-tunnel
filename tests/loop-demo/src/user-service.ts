import type { User, CreateUserInput, UserFilter } from "./types.js";
import { isValidEmail, generateId, formatTimestamp } from "./utils.js";

/**
 * 用户服务 — 需按 spec.md 实现
 *
 * 当前状态: 空壳，等待 Loop Engineering 实施循环填充
 */

const users = new Map<string, User>();

export function createUser(input: CreateUserInput): User {
  // 占位 — 待 task session 实现
  throw new Error("not implemented");
}

export function getUsers(filter?: UserFilter): User[] {
  // 占位
  return [];
}

export function getUserById(id: string): User | null {
  // 占位
  return null;
}

export function updateUser(id: string, updates: Partial<CreateUserInput>): User | null {
  // 占位
  return null;
}

export function deleteUser(id: string): boolean {
  // 占位
  return false;
}
