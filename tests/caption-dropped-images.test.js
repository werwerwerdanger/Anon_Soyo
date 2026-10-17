import test from 'node:test';
import assert from 'node:assert/strict';

import { prepareImageInput, shouldSkipImageCaption, mainModelSupportsImage } from '../src/image-input.js';

// 与 index.js 的 `caption-dropped-images` 补丁一致的「强制转述」配置：
// 主模型自己能看图时默认走"直传"（图只进请求、不进历史），而"没触发她"的消息
// 根本不会发请求 ⇒ 直传等于没看。所以补丁把这两项改掉，强制走转述拿文字入库。
function forcedCaptionConfig() {
    const config = {
        ai: {
            baseUrl: 'https://api.example.com',
            apiKey: 'k',
            timeout: 5000,
            activeProviderId: 'default',
            providers: [{
                id: 'default',
                baseUrl: 'https://api.example.com',
                apiKey: 'k',
                model: 'vision-model',
                models: [{ id: 'vision-model', supportsImage: true }]
            }]
        },
        chat: { model: 'vision-model', modelProviderId: 'default' }
    };
    return {
        ...config,
        chat: {
            ...config.chat,
            imageCaptionModel: 'vision-model',
            imageCaptionModelProviderId: 'default',
            imageCaptionSkipWhenModelSupportsImage: false
        }
    };
}

test('强制转述：主模型支持图片时也能拿到转述文字（补丁依赖的机制）', async () => {
    const config = forcedCaptionConfig();
    // 前提检查：这个配置下主模型确实是"能看图"的，默认会被跳过转述
    assert.equal(mainModelSupportsImage(config), true);
    assert.equal(shouldSkipImageCaption(config), false, '显式关掉 skip 之后不该再跳过转述');

    let calls = 0;
    const aiClient = {
        chat: async () => { calls += 1; return { content: '一只粉色头发的女孩在打鼓' }; },
        getVisibleResponseContent: (result) => result?.content || ''
    };
    const event = {
        user_id: 2063362809,
        message: [{ type: 'image', data: { url: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' } }]
    };

    const result = await prepareImageInput({ items: [{ event }], config, bot: {}, aiClient });

    assert.equal(result.mode, 'caption', '应走转述而不是直传');
    assert.equal(calls, 1, '应恰好调用一次转述模型');
    assert.match(result.captionText, /打鼓/, '转述文字要进 captionText');
    assert.match(result.captionText, /image_caption/, '要包成 image_caption 块（和正常回复路径同一格式）');
});

test('默认配置（未强制）下主模型能看图时仍跳过转述，保持原行为', async () => {
    const config = forcedCaptionConfig();
    config.chat.imageCaptionSkipWhenModelSupportsImage = true;
    let calls = 0;
    const aiClient = {
        chat: async () => { calls += 1; return { content: '不该被调用' }; },
        getVisibleResponseContent: (result) => result?.content || ''
    };
    const event = {
        user_id: 2063362809,
        message: [{ type: 'image', data: { url: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' } }]
    };

    const result = await prepareImageInput({ items: [{ event }], config, bot: {}, aiClient });
    assert.equal(result.mode, 'direct');
    assert.equal(calls, 0, '默认行为不能被改动 —— 正常回复路径仍直传原图');
});
