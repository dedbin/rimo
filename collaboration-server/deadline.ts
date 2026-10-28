export class DeadlineExceededError extends Error {
  constructor() {
    super("Access check timed out");
    this.name = "DeadlineExceededError";
  }
}

export async function withDeadline<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceededError()), milliseconds);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
