# Loop Engineering 测试场景

此目录是一个**故意留空的 mini 项目**，用于测试 Loop Engineering 的两种模式。

## 项目状态

| 文件 | 状态 | 说明 |
|------|:--:|------|
| `spec.md` | ✅ 完整 | 功能规格（5 函数 + 4 约束） |
| `src/types.ts` | ✅ 已实现 | 类型定义齐全 |
| `src/utils.ts` | ❌ 空壳 | 3 个函数待实现 |
| `src/user-service.ts` | ❌ 空壳 | 5 个方法待实现 |

---

## 场景 A: 实施循环（Implement Loop）

**目标**：让 task session 按照 `spec.md` 实现 `utils.ts` 和 `user-service.ts`。

**PM 操作流程**：

```
1. Skill 加载 → Q1=A (Loop Engineering) → Q2=A (实施) → Q3=A (单 session)
2. create_session(cwd="tests/loop-demo", permission_mode="auto")
3. execute_prompt(sid, "按 spec.md 实现 src/utils.ts 的 3 个函数")
   → Bash 后台轮询 → 收到回复
4. grade_step(sid, "1. isValidEmail 验证 @ 和 . 存在\n2. generateId 返回 user_ 前缀 + 8 hex\n3. formatTimestamp 返回 ISO 8601")
   → {pass, score, feedback}
5. pass → execute_prompt(sid, "按 spec.md 实现 src/user-service.ts 的 5 个方法")
6. grade_step(sid, "1. createUser 验证邮箱+去重+自动id\n2. getUsers 支持role/nameContains过滤\n3. getUserById 按id查找\n4. updateUser 部分更新+email去重\n5. deleteUser 返回boolean")
```

### grade_step 验收标准（utils.ts）

```
1. isValidEmail 对 "test@example.com" 返回 true
2. isValidEmail 对 "invalid" 返回 false
3. generateId 返回格式为 "user_" + 8 位十六进制字符
4. formatTimestamp() 返回当前 ISO 8601 时间字符串
5. formatTimestamp(date) 返回指定日期的 ISO 8601 字符串
```

### grade_step 验收标准（user-service.ts）

```
1. createUser({name, email}) 返回 User 对象含自动生成的 id 和 createdAt
2. createUser 重复 email 抛出 "email already exists"
3. getUsers({role:"admin"}) 只返回 role=admin 的用户
4. getUsers({nameContains:"张"}) 只返回 name 含 "张" 的用户
5. getUsers() 无参数返回全部用户
6. getUserById 存在的 id 返回 User，不存在的返回 null
7. updateUser 存在的 id 部分更新各字段，返回更新后的 User
8. updateUser 修改 email 时检查不重复，重复抛错
9. deleteUser 删除存在的 id 返回 true，不存在的返回 false
10. 删除后再 getUserById 返回 null
```

---

## 场景 B: 验收循环（Verify Loop）

**目标**：审查已完成的实现是否符合 `spec.md`。

**PM 操作流程**：

```
1. Skill 加载 → Q1=A (Loop Engineering) → Q2=B (验收) → Q3=A (单 session)
2. execute_prompt(sid, "对照 spec.md §2 逐条审查 src/utils.ts 的 3 个函数，输出结构化问题清单（文件路径+行号+严重度+描述）")
   → Bash 后台轮询 → 收到审查报告
3. grade_step(sid, "审查报告应包含: 1) 每个函数有明确状态(✅/⚠️/❌) 2) 问题有严重度 3) 引用具体文件路径和行号 4) 对照 spec.md 逐条列出差异")
4. 根据 grade 结果: pass→交付, fail→生成修复清单→发给修复 session→重验
```

---

## 场景 C: 多 session 并行验收

**目标**：将审查按维度拆分到 3 个 session 并行执行。

```
1. Skill 加载 → Q1=A → Q2=B (验收) → Q3=B (多 session 并行)
2. Session A: 审查 utils.ts 正确性
3. Session B: 审查 user-service.ts 完整度
4. Session C: 审查 types.ts 与 spec 一致性
5. 并行 grade_step → 汇总 → 跨 session 一致性检查
```

---

## 测试验证

实现完成后，可在项目根目录运行验证：

```bash
cd tests/loop-demo
npx tsx -e "
import { createUser, getUsers, getUserById, updateUser, deleteUser } from './src/user-service.js';

const u1 = createUser({ name: 'Alice', email: 'a@test.com', role: 'admin' });
const u2 = createUser({ name: 'Bob', email: 'b@test.com' });

console.assert(u1.role === 'admin', 'role should be admin');
console.assert(u2.role === 'user', 'default role should be user');
console.assert(u1.id.startsWith('user_'), 'id should start with user_');
console.assert(deleteUser(u1.id) === true, 'delete should return true');
console.assert(getUserById(u1.id) === null, 'deleted user should be null');

try { createUser({ name: 'C', email: 'b@test.com' }); console.assert(false, 'should throw'); }
catch (e) { console.assert(e.message === 'email already exists', 'should throw duplicate'); }

console.log('All assertions passed ✅');
"
```
