const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// 启用 stealth 插件以绕过 Cloudflare 检测
chromium.use(stealth);

// --- 环境变量读取 (对应 GitHub Secrets) ---
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const IS_GITHUB = process.env.GITHUB_ACTIONS === 'true';

// --- 核心辅助函数：仅发送文字通知 ---
async function sendTelegram(message) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
        console.log('[TG] Skip notification: Token or ChatID missing.');
        return;
    }
    try {
        const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TG_CHAT_ID,
            text: message,
            parse_mode: 'HTML' // 支持粗体等格式
        });
        console.log(`[TG] Notification sent: ${message.replace(/<[^>]*>/g, '')}`);
    } catch (e) {
        console.error('[TG] Failed to send notification:', e.message);
    }
}

// --- Cloudflare Turnstile 注入逻辑 ---
const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;
    const originalAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function(init) {
        const shadowRoot = originalAttachShadow.call(this, init);
        if (shadowRoot) {
            const checkAndReport = () => {
                const checkbox = shadowRoot.querySelector('input[type="checkbox"]');
                if (checkbox && checkbox.getBoundingClientRect().width > 0) {
                    const rect = checkbox.getBoundingClientRect();
                    window.__turnstile_data = { 
                        xRatio: (rect.left + rect.width / 2) / window.innerWidth, 
                        yRatio: (rect.top + rect.height / 2) / window.innerHeight 
                    };
                    return true;
                }
                return false;
            };
            const observer = new MutationObserver(() => { if (checkAndReport()) observer.disconnect(); });
            observer.observe(shadowRoot, { childList: true, subtree: true });
        }
        return shadowRoot;
    };
})();
`;

async function attemptTurnstileCdp(page) {
    for (const frame of page.frames()) {
        const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
        if (data) {
            const box = await (await frame.frameElement()).boundingBox();
            if (!box) continue;
            const client = await page.context().newCDPSession(page);
            const x = box.x + box.width * data.xRatio, y = box.y + box.height * data.yRatio;
            await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
            await new Promise(r => setTimeout(r, 100));
            await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
            await client.detach();
            return true;
        }
    }
    return false;
}

// --- 主程序 ---
(async () => {
    let browser;
    try {
        // GitHub 环境下必须使用无头模式
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const context = await browser.newContext();
        
        // 从 login.json 读取用户
        const users = JSON.parse(fs.readFileSync(path.join(__dirname, 'login.json'), 'utf8'));

        for (const user of users) {
            console.log(`\n>>> 正在处理用户: ${user.username}`);
            const page = await context.newPage();
            await page.addInitScript(INJECTED_SCRIPT);

            try {
                // 1. 登录流程
                await page.goto('https://dashboard.katabump.com/auth/login');
                const emailInput = page.getByRole('textbox', { name: 'Email' });
                if (await emailInput.isVisible({ timeout: 5000 })) {
                    await emailInput.fill(user.username);
                    await page.getByRole('password').fill(user.password);
                    await page.getByRole('button', { name: 'Login' }).click();
                }

                // 检查登录错误
                const errorMsg = page.getByText('Incorrect password or no account');
                if (await errorMsg.isVisible({ timeout: 4000 })) {
                    await sendTelegram(`❌ <b>登录失败</b>\n用户: ${user.username}\n原因: 账号或密码错误`);
                    await page.close();
                    continue;
                }

                // 2. 导航至续期页面
                await page.goto('https://dashboard.katabump.com/dashboard');
                await page.getByRole('link', { name: 'See' }).first().click();

                // 3. 循环尝试续期
                let renewSuccess = false;
                for (let attempt = 1; attempt <= 5; attempt++) {
                    const renewBtn = page.getByRole('button', { name: 'Renew' }).first();
                    await renewBtn.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});

                    if (await renewBtn.isVisible()) {
                        await renewBtn.click();
                        const modal = page.locator('#renew-modal');
                        await modal.waitFor({ state: 'visible' });

                        // 点击验证码
                        for (let i = 0; i < 10; i++) {
                            if (await attemptTurnstileCdp(page)) break;
                            await page.waitForTimeout(1000);
                        }
                        
                        await page.waitForTimeout(3000);
                        await modal.getByRole('button', { name: 'Renew' }).click();

                        // 状态判断
                        await page.waitForTimeout(3000);
                        const notTime = page.getByText("You can't renew your server yet");
                        
                        if (await notTime.isVisible()) {
                            const dateText = await notTime.innerText();
                            await sendTelegram(`⏳ <b>无需续期</b>\n用户: ${user.username}\n状态: ${dateText.split('(')[0].trim()}`);
                            renewSuccess = true;
                            break;
                        }

                        if (!await modal.isVisible()) {
                            await sendTelegram(`✅ <b>续期成功</b>\n用户: ${user.username}\n尝试次数: ${attempt}`);
                            renewSuccess = true;
                            break;
                        }
                        await page.reload();
                    } else {
                        break;
                    }
                }
            } catch (err) {
                console.error(`[Error] ${user.username}:`, err.message);
            }
            await page.close();
        }
    } catch (globalErr) {
        console.error('Global error:', globalErr);
    } finally {
        if (browser) await browser.close();
    }
})();
