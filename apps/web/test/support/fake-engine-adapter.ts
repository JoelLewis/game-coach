import type { AnalyseMoveInput, EngineAdapter, MoveFacts } from "@game-coach/contracts/engine";
import { deferred } from "./deferred.ts";

export class FakeEngineAdapter implements EngineAdapter {
  readonly game = "chess" as const;
  readonly analyseCalls: AnalyseMoveInput[] = [];
  readonly chooseOpponentMoveCalls: Array<{ position: string; level: number }> = [];
  disposed = false;

  private readonly readyDeferred = deferred<void>();
  private readonly factsByPly: Map<number, MoveFacts>;
  private readonly replyByPosition: Map<string, string>;

  constructor(factsByPly: Map<number, MoveFacts>, replyByPosition: Map<string, string>) {
    this.factsByPly = factsByPly;
    this.replyByPosition = replyByPosition;
  }

  resolveReady(): void {
    this.readyDeferred.resolve();
  }

  ready(): Promise<void> {
    return this.readyDeferred.promise;
  }

  async analyseMove(input: AnalyseMoveInput): Promise<MoveFacts> {
    this.analyseCalls.push(input);
    const facts = this.factsByPly.get(input.ply);
    if (!facts) throw new Error(`FakeEngineAdapter: no scripted facts for ply ${input.ply}`);
    return facts;
  }

  async chooseOpponentMove(position: string, level: number): Promise<string> {
    this.chooseOpponentMoveCalls.push({ position, level });
    const move = this.replyByPosition.get(position);
    if (!move) throw new Error(`FakeEngineAdapter: no scripted reply for ${position}`);
    return move;
  }

  dispose(): void {
    this.disposed = true;
  }
}
