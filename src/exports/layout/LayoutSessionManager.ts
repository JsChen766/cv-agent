import { ResumeLayoutOracle, type ResumeLayoutSession } from "./ResumeLayoutOracle.js";

export class LayoutSessionManager {
  public constructor(private readonly oracle = new ResumeLayoutOracle()) {}

  public async withSession<T>(
    input: { layoutSessionId: string; templateId: string; density: string },
    fn: (session: ResumeLayoutSession) => Promise<T>,
  ): Promise<T> {
    const session = await this.oracle.createSession(input);
    try {
      return await fn(session);
    } finally {
      await session.close();
    }
  }
}
