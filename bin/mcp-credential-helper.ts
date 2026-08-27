#!/usr/bin/env node

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

interface CredentialRecord {
  token: string;
  updatedAt: string;
}

interface CredentialStore {
  version: 1;
  profiles: Record<string, CredentialRecord>;
}

const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const storePath = (): string => {
  const configRoot = process.platform === 'win32'
    ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configRoot, 'mcp-credentials', 'credentials.json');
};

const readStore = (filePath: string): CredentialStore => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null ||
        !('version' in parsed) || parsed.version !== 1 ||
        !('profiles' in parsed) || typeof parsed.profiles !== 'object' ||
        parsed.profiles === null || Array.isArray(parsed.profiles)) {
      throw new Error('格式无效');
    }
    return parsed as CredentialStore;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { version: 1, profiles: {} };
    }
    throw new Error(`凭据存储读取失败：${filePath}`);
  }
};

const writeStore = (filePath: string, store: CredentialStore): void => {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  if (process.platform !== 'win32') {
    chmodSync(temporaryPath, 0o600);
  }
  renameSync(temporaryPath, filePath);
  if (process.platform !== 'win32') {
    chmodSync(filePath, 0o600);
  }
};

const profile = (value: string | undefined): string => {
  if (!value || !PROFILE_PATTERN.test(value)) {
    throw new Error('profile 必须是 1 到 64 个字母、数字、点、下划线或连字符');
  }
  return value;
};

const readStdin = (): string => readFileSync(0, 'utf8').trim().replace(/^Bearer\s+/i, '').trim();

const readInteractiveToken = (): Promise<string> => {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    return Promise.resolve(readStdin());
  }
  process.stdout.write('Token: ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = (): void => {
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      process.stdin.off('data', onData);
    };
    const onData = (chunk: Buffer): void => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          reject(new Error('已取消凭据输入'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(value.replace(/^Bearer\s+/i, '').trim());
          return;
        }
        if (character === '\u007f' || character === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        value += character;
        process.stdout.write('*');
      }
    };
    process.stdin.on('data', onData);
  });
};

const usage = (): void => {
  process.stdout.write([
    'Usage: mcp-credential-helper <set|token|status|clear> [profile]',
    '',
    'set    输入并保存凭据。',
    'token  向 stdout 输出 Token，供 MCP Provider 调用。',
    'status 显示 profile 是否存在，不显示 Token。',
    'clear  清除指定 profile 的凭据。',
    '',
  ].join('\n'));
};

const parseArgs = (args: string[]): { command: string; profile: string } => {
  const command = args[0];
  if (!command || command === '--help' || command === '-h') {
    usage();
    process.exit(0);
  }
  if (!['set', 'token', 'status', 'clear'].includes(command)) {
    throw new Error(`未知命令：${command}`);
  }
  const profileIndex = args.indexOf('--profile');
  const positionalProfile = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
  const selectedProfile = profileIndex >= 0 ? args[profileIndex + 1] : positionalProfile;
  return { command, profile: profile(selectedProfile) };
};

const main = async (): Promise<void> => {
  const { command, profile: profileName } = parseArgs(process.argv.slice(2));
  const filePath = storePath();
  const store = readStore(filePath);
  const record = store.profiles[profileName];
  if (command === 'set') {
    const token = process.stdin.isTTY ? await readInteractiveToken() : readStdin();
    if (!token) {
      throw new Error('stdin 中未提供 Token');
    }
    store.profiles[profileName] = { token, updatedAt: new Date().toISOString() };
    writeStore(filePath, store);
    process.stdout.write(`已保存 profile：${profileName}\n`);
    return;
  }
  if (command === 'token') {
    if (!record?.token) {
      throw new Error(`未找到 profile：${profileName}`);
    }
    process.stdout.write(`${record.token}\n`);
    return;
  }
  if (command === 'status') {
    process.stdout.write(`${record?.token ? 'configured' : 'missing'}\n`);
    return;
  }
  if (record) {
    delete store.profiles[profileName];
    writeStore(filePath, store);
  }
  process.stdout.write(`已删除 profile：${profileName}\n`);
};

try {
  await main();
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
