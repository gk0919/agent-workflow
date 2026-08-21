import assert from 'node:assert/strict';
import process from 'node:process';
import {
  analyzeJavaScriptPatch,
  createPatchForNewFile,
} from '../../src/validators/check-js-diff.js';
import { errorMessage } from '../../src/types/guards.js';

const analyzeContent = (content: string) => analyzeJavaScriptPatch(
  'example.js',
  createPatchForNewFile(content, 'example.js'),
);

/** 运行 JS 注释 Warning 的确定性回归用例。 */
export const main = (): number => {
  try {
    const cleanResult = analyzeContent([
      '/** 将输入转换为稳定的公共格式。 */',
      'export const normalizeValue = (value) => value;',
      '',
      '// 保持旧入口的返回顺序，避免存量调用方字段错位。',
      'const preserveLegacyOrder = true;',
      '// return value must remain stable for old callers',
      'const localValue = 1;',
    ].join('\n'));
    assert.deepEqual(cleanResult.errors, []);
    assert.deepEqual(cleanResult.warnings, []);

    const bareWorkResult = analyzeContent('// TODO\nconst value = 1;');
    assert.match(bareWorkResult.warnings.join('\n'), /TODO\/FIXME 缺少原因/);
    const explainedWorkResult = analyzeContent(
      '// TODO: XQ-123 完成接口迁移后删除兼容分支\nconst value = 1;',
    );
    assert.doesNotMatch(
      explainedWorkResult.warnings.join('\n'),
      /TODO\/FIXME 缺少原因/,
    );

    const commentedCodeResult = analyzeContent(
      '// const legacyValue = getLegacyValue();\nconst value = 1;',
    );
    assert.match(
      commentedCodeResult.warnings.join('\n'),
      /疑似新增注释掉的旧代码/,
    );

    const undocumentedExportResult = analyzeContent(
      'export function loadValue() {\n  return 1;\n}',
    );
    assert.match(
      undocumentedExportResult.warnings.join('\n'),
      /新增导出函数\/类未在同一 patch 中附带 JSDoc/,
    );
    const localFunctionResult = analyzeContent(
      'function loadValue() {\n  return 1;\n}',
    );
    assert.doesNotMatch(
      localFunctionResult.warnings.join('\n'),
      /JSDoc/,
    );

    process.stdout.write(
      'JS 注释增量回归通过：公共契约、裸 TODO/FIXME 和注释代码 Warning 正常。\n',
    );
    return 0;
  } catch (error: unknown) {
    process.stderr.write(`JS 注释增量回归失败：${errorMessage(error)}\n`);
    return 1;
  }
};

process.exitCode = main();
