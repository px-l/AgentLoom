import { test, expect } from '@playwright/test';
test('应用、画布、知识检索与设置可用', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const a = await (await page.request.get('/api/apps/example-app-0')).json();
  await page.request.put('/api/apps/example-app-0', {
    data: { name: '知识问答', description: a.description, graph: a.draft, revision: a.revision },
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '把想法，织成应用.' })).toBeVisible();
  await expect(page.getByRole('link', { name: '知识问答' })).toBeVisible();
  await page.screenshot({ path: '../../docs/screenshot-apps.png', fullPage: true });
  await page.getByRole('link', { name: '知识问答' }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(4);
  await page.getByRole('button', { name: '校验', exact: true }).click();
  await expect(page.getByText('图校验通过')).toBeVisible();
  await page.screenshot({ path: '../../docs/screenshot-editor.png' });
  await page.getByRole('button', { name: '调试运行' }).click();
  await page.getByRole('textbox', { name: 'question', exact: true }).fill('人工审批如何在服务重启后恢复？');
  await page.getByRole('button', { name: '开始执行' }).click();
  await expect(page.getByText('执行结果', { exact: true })).toBeVisible({ timeout: 20000 });
  await expect(page.getByText('真实来源')).toBeVisible();
  await page.getByRole('link', { name: '完整追踪' }).click();
  await page.reload();
  await expect(page.getByText('执行结果', { exact: true })).toBeVisible();
  await page.screenshot({ path: '../../docs/screenshot-run.png', fullPage: true });
  await page.getByRole('link', { name: '知识库', exact: true }).click();
  await page.getByRole('button', { name: '检索测试' }).click();
  await page.getByRole('textbox', { name: '检索问题' }).fill('人工审批如何恢复');
  await page.getByRole('button', { name: '检索', exact: true }).click();
  await expect(page.locator('.hit-card')).toHaveCount(3);
  await page.getByRole('link', { name: /设置/ }).click();
  await expect(page.getByRole('heading', { name: '平台设置' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('创建、属性编辑、撤销重做、保存、发布和运行', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '创建应用', exact: true }).click();
  await page.getByRole('textbox', { name: '应用名称' }).fill('浏览器验收工作流');
  await page.getByRole('button', { name: '创建并编排' }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  await page.getByRole('button', { name: /大语言模型 LLM/ }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await page.locator('.react-flow__node[data-id="end"]').click();
  await page.getByRole('textbox', { name: '最终输出模板' }).fill('已验收：{{input.question}}');
  await expect(page.getByText('草稿已保存', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '发布', exact: true }).click();
  await expect(page.getByText('已发布不可变版本')).toBeVisible();
  await page.getByRole('button', { name: '调试运行' }).click();
  await page.getByRole('textbox', { name: 'question', exact: true }).fill('持久化执行');
  await page.getByRole('button', { name: '开始执行' }).click();
  await expect(page.locator('.report').getByText('已验收：持久化执行', { exact: true })).toBeVisible({
    timeout: 15000,
  });
});

test('需求评审通过真实工具、暂停和人工修订后继续', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: '需求评审', exact: true }).click();
  await page.getByRole('button', { name: '调试运行' }).click();
  await page.getByRole('textbox', { name: 'requirement', exact: true }).fill('设计持久化人工审批与断线恢复');
  await page.getByRole('button', { name: '开始执行' }).click();
  await expect(page.getByRole('button', { name: '确认并继续' })).toBeEnabled({ timeout: 15000 });
  await page.screenshot({ path: '../../docs/screenshot-approval.png' });
  await page
    .getByRole('textbox', { name: '审批内容' })
    .fill('# 人工修订报告\n\n已确认重启恢复与幂等边界。 [example-doc-0-0]');
  await page.getByRole('button', { name: '确认并继续' }).click();
  await expect(page.getByText('执行结果', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.report')).toContainText('人工修订报告');
  await page.getByRole('button', { name: '工具调用', exact: true }).click();
  await expect(page.getByText('工具调用 1', { exact: false })).toBeVisible();
});
