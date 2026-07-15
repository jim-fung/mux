import type { TodoItem } from "@/common/types/tools";
import { completeInProgressTodoItems } from "@/common/utils/todoList";

import { parseTodoWriteInput } from "./schemas";

/**
 * Tracks the current TODO list (updated from `todo_write` tool results).
 *
 * Keeps stable array identity — only replaces the internal array when the
 * list actually changes — so memoized consumers don't churn.
 */
export class TodoStore {
  private currentTodos: TodoItem[] = [];

  get(): TodoItem[] {
    return this.currentTodos;
  }

  /** True if every item is completed. */
  isAllCompleted(): boolean {
    return (
      this.currentTodos.length > 0 && this.currentTodos.every((todo) => todo.status === "completed")
    );
  }

  /** Clear the list if every item is completed (called on idle / stream end). */
  clearIfAllCompleted(): void {
    if (this.isAllCompleted()) {
      this.currentTodos = [];
    }
  }

  /** Mark in-progress items as completed (called on successful `propose_plan`). */
  completeInProgress(): void {
    const completedTodos = completeInProgressTodoItems(this.currentTodos);
    if (completedTodos !== this.currentTodos) {
      this.currentTodos = completedTodos;
    }
  }

  /**
   * Update todos from a `todo_write` tool result.
   * Returns `true` if the list actually changed.
   */
  updateFromToolResult(input: unknown, output: unknown): boolean {
    if (!output) return false;

    const args = parseTodoWriteInput(input);
    if (args && !this.todosEqual(this.currentTodos, args.todos)) {
      this.currentTodos = args.todos;
      return true;
    }
    return false;
  }

  /** Deep-equality check to avoid replacing the array on no-op writes. */
  private todosEqual(a: TodoItem[], b: TodoItem[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((todoA, i) => {
      const todoB = b[i];
      return todoA.content === todoB.content && todoA.status === todoB.status;
    });
  }
}
