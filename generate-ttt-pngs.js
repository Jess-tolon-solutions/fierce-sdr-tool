const puppeteer = require('puppeteer');
const path = require('path');

async function generatePNGs() {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();

    // Set high resolution viewport with 2x device scale factor
    await page.setViewport({
        width: 1400,
        height: 2000,
        deviceScaleFactor: 2
    });

    // Load the HTML file
    const htmlPath = `file://${path.join(__dirname, 'ttt-graphics.html')}`;
    await page.goto(htmlPath, { waitUntil: 'networkidle0' });

    // Wait for fonts and images to load
    await page.evaluateHandle('document.fonts.ready');
    await new Promise(r => setTimeout(r, 2000));

    // Screenshot LinkedIn Feed (1200x627) - will be 2400x1254 at 2x
    const linkedinFeed = await page.$('.linkedin-graphic');
    await linkedinFeed.screenshot({
        path: path.join(__dirname, 'ttt-linkedin-feed.png'),
        type: 'png',
        omitBackground: false
    });
    console.log('Created: ttt-linkedin-feed.png (2400x1254 @2x)');

    // Screenshot Newsletter Banner (600x200) - will be 1200x400 at 2x
    const newsletter = await page.$('.newsletter-banner');
    await newsletter.screenshot({
        path: path.join(__dirname, 'ttt-newsletter-banner.png'),
        type: 'png',
        omitBackground: false
    });
    console.log('Created: ttt-newsletter-banner.png (1200x400 @2x)');

    // Screenshot LinkedIn Square (1080x1080) - will be 2160x2160 at 2x
    const linkedinSquare = await page.$('.linkedin-square');
    await linkedinSquare.screenshot({
        path: path.join(__dirname, 'ttt-linkedin-square.png'),
        type: 'png',
        omitBackground: false
    });
    console.log('Created: ttt-linkedin-square.png (2160x2160 @2x)');

    await browser.close();
    console.log('\nAll high-resolution PNG files generated successfully!');
}

generatePNGs().catch(console.error);
