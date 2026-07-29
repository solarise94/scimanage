#!/usr/bin/env python3
import asyncio
import os
from playwright.async_api import async_playwright

BASE_URL = os.environ.get("SCREENSHOT_BASE_URL", "http://127.0.0.1:3000")
LOGIN_URL = f"{BASE_URL}/login"
CUSTOMER_URL = f"{BASE_URL}/crm/customers/demo-customer-01"
# screenshots 落在本脚本所在目录（仓库 scripts/）
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 375, "height": 812})
        page = await context.new_page()

        # 1. Login
        login_email = os.environ.get("SCREENSHOT_EMAIL", "admin@example.com")
        login_password = os.environ.get("SCREENSHOT_PASSWORD")
        if not login_password:
            raise RuntimeError("请设置 SCREENSHOT_PASSWORD 环境变量")
        await page.goto(LOGIN_URL)
        await page.fill('input[name="email"]', login_email)
        await page.fill('input[name="password"]', login_password)
        await page.click('button[type="submit"]')
        await page.wait_for_url(f"{BASE_URL}/dashboard", timeout=10000)
        print("Logged in")

        # 2. Go to customer detail
        await page.goto(CUSTOMER_URL)
        await page.wait_for_load_state("networkidle")
        await asyncio.sleep(1)

        # 3. Switch to "跟进任务" tab
        # Mobile: click the Select trigger, then click the option
        await page.click('button[role="combobox"]')
        await asyncio.sleep(0.3)
        await page.click('text=跟进任务')
        await asyncio.sleep(1)
        await page.screenshot(path=os.path.join(SCRIPT_DIR, "screenshot-follow-ups.png"), full_page=False)
        print("Screenshot: screenshot-follow-ups.png")

        # 4. Switch to "关系网络" tab
        await page.click('button[role="combobox"]')
        await asyncio.sleep(0.3)
        await page.click('text=关系网络')
        await asyncio.sleep(1)
        await page.screenshot(path=os.path.join(SCRIPT_DIR, "screenshot-relations.png"), full_page=False)
        print("Screenshot: screenshot-relations.png")

        await browser.close()

asyncio.run(main())
