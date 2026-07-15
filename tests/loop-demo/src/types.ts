export interface User {
  id: string;
  name: string;
  email: string;
  role: "admin" | "user";
  createdAt: string;
}

export interface CreateUserInput {
  name: string;
  email: string;
  role?: "admin" | "user";
}

export interface UserFilter {
  role?: "admin" | "user";
  nameContains?: string;
}
