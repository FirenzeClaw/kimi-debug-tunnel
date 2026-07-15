# User Service — 功能规格

## 1. 数据类型（src/types.ts）

- `User` 接口包含: `id: string`, `name: string`, `email: string`, `role: "admin" | "user"`, `createdAt: string` (ISO 8601)
- `CreateUserInput` 接口包含: `name: string`, `email: string`, `role?: "admin" | "user"` (默认 "user")
- `UserFilter` 接口包含: `role?: "admin" | "user"`, `nameContains?: string`

## 2. 工具函数（src/utils.ts）

- `isValidEmail(email: string): boolean` — 验证邮箱格式（含 @ 且 @ 后有 .）
- `generateId(): string` — 返回 `user_` 前缀 + 8 位随机 hex
- `formatTimestamp(date?: Date): string` — 返回 ISO 8601 字符串，缺省用当前时间

## 3. 用户服务（src/user-service.ts）

- `createUser(input: CreateUserInput): User` — 创建用户，验证邮箱有效，自动生成 id + createdAt
- `getUsers(filter?: UserFilter): User[]` — 按 role/nameContains 过滤，不传 filter 返回全部
- `getUserById(id: string): User | null` — 按 id 查找
- `updateUser(id: string, updates: Partial<CreateUserInput>): User | null` — 部分更新，找不到返回 null
- `deleteUser(id: string): boolean` — 删除用户，找到并删除返回 true

## 4. 约束

- 所有函数不依赖外部库
- email 校验仅需基本格式检查（无需 RFC 完整校验）
- 数据存储在内存 `Map<string, User>` 中
- `createUser` 重复 email 应抛出 `"email already exists"`
- `updateUser` 修改 email 时需验证新 email 不重复
