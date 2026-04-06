import { createHash } from 'node:crypto';

export interface DeepSeekPowChallenge {
  algorithm: string;
  challenge: string;
  difficulty: number;
  salt: string;
  signature: string;
  expire_at?: number;
}

/**
 * Solve DeepSeek SHA256 Proof of Work challenge.
 * Returns the nonce that produces a hash with enough leading zero bits.
 */
export function solvePowSha256(challenge: DeepSeekPowChallenge): number {
  if (challenge.algorithm !== 'sha256') {
    throw new Error(`Unsupported PoW algorithm: ${challenge.algorithm}. Only sha256 is supported.`);
  }

  const { challenge: target, salt, difficulty } = challenge;
  const targetDifficulty = difficulty > 1000
    ? Math.floor(Math.log2(difficulty))
    : difficulty;

  let nonce = 0;

  while (nonce < 10_000_000) {
    const input = salt + target + nonce;
    const hash = createHash('sha256').update(input).digest('hex');

    let zeroBits = 0;
    for (const char of hash) {
      const val = parseInt(char, 16);
      if (val === 0) {
        zeroBits += 4;
      } else {
        zeroBits += Math.clz32(val) - 28;
        break;
      }
    }

    if (zeroBits >= targetDifficulty) {
      return nonce;
    }

    nonce++;
  }

  throw new Error(`SHA256 PoW timeout after ${nonce} iterations`);
}

/**
 * Build the x-ds-pow-response header value.
 */
export function buildPowResponse(
  challenge: DeepSeekPowChallenge,
  answer: number,
  targetPath: string,
): string {
  const obj = {
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    difficulty: challenge.difficulty,
    salt: challenge.salt,
    signature: challenge.signature,
    ...(challenge.expire_at !== undefined && { expire_at: challenge.expire_at }),
    answer,
    target_path: targetPath,
  };
  return Buffer.from(JSON.stringify(obj)).toString('base64');
}
