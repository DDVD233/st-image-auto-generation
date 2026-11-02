// The main script for the extension
// The following are examples of some basic extension functionality

//You'll likely need to import extension_settings, getContext, and loadExtensionSettings from extensions.js
import { extension_settings, getContext } from '../../../extensions.js';
//You'll likely need to import some other functions from the main script
import {
    saveSettingsDebounced,
    eventSource,
    event_types,
    updateMessageBlock,
    chat,
    streamingProcessor,
} from '../../../../script.js';
import { appendMediaToMessage } from '../../../../script.js';
import { regexFromString } from '../../../utils.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';

// 扩展名称和路径
const extensionName = 'st-image-auto-generation';
// /scripts/extensions/third-party
const extensionFolderPath = `/scripts/extensions/third-party/${extensionName}`;

// 插入类型常量
const INSERT_TYPE = {
    DISABLED: 'disabled',
    INLINE: 'inline',
    NEW_MESSAGE: 'new',
    REPLACE: 'replace',
};

/**
 * Escapes characters for safe inclusion inside HTML attribute values.
 * @param {string} value
 * @returns {string}
 */
function escapeHtmlAttribute(value) {
    if (typeof value !== 'string') {
        return '';
    }

    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        // A line break inside the tag would make markdown split it up and show
        // it as text.
        .replace(/\r?\n/g, '&#10;');
}

/**
 * Reverses {@link escapeHtmlAttribute} to recover the original prompt text.
 * @param {string} value
 * @returns {string}
 */
function unescapeHtmlAttribute(value) {
    if (typeof value !== 'string') {
        return '';
    }

    return value
        .replace(/&#10;/g, '\n')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&'); // 必须放在最后，避免二次反转义
}

/**
 * Restores the <img> tags this extension generated in REPLACE mode back to the
 * exact original tag the model emitted (stored verbatim in data-pic-gen). This
 * is format-agnostic, so it works with any custom prompt template / regex. Only
 * tags carrying our data-pic-gen marker are touched, so user/character images
 * are left untouched.
 *
 * Images saved by earlier versions only have the prompt in data-pic-gen, which
 * is how they differ from newer ones: it's the same as their title. Those go
 * back to a <pic prompt="..."> tag, or the model would see a bare prompt.
 *
 * Unclosed tags go back closed, or the model would copy them from its history.
 * @param {string} content
 * @returns {string}
 */
function restorePicTags(content) {
    return content.replace(
        /<img\b[^>]*?\sdata-pic-gen="([^"]*)"[^>]*>/g,
        (match, escapedValue) => {
            const value = unescapeHtmlAttribute(escapedValue);
            return match.includes(` title="${escapedValue}"`)
                ? `<pic prompt="${value}">`
                : value.replace(UNCLOSED_TAG_REGEX, '<pic prompt="$1">');
        },
    );
}

// A generated <img> tag, captured so that split() keeps it. Its data-pic-gen holds
// the original tag, which in a custom format may have nothing to escape and so
// still match the regex: these must be skipped when working with tags.
const GENERATED_IMAGE_REGEX = /(<img\b[^>]*?\sdata-pic-gen="[^"]*"[^>]*>)/g;

// A tag the model left unclosed: <pic prompt="...</pic>, or <pic prompt="...> at the
// end of a paragraph. The usual regex would run on to the next quote in the text,
// taking the text in between as the prompt and swallowing any tags after it. A ">"
// elsewhere doesn't count: valid prompts can have them, as in <lora:name:1>.
const UNCLOSED_TAG_REGEX =
    /<pic\b[^>]*\sprompt="([^"]*?)(?:<\/pic>|>(?=\s*\n\s*\n|$))/g;

/**
 * Ensures message.extra.image_swipes always exists and is an array.
 * @param {any} message
 * @returns {string[]}
 */
function ensureImageSwipes(message) {
    if (!message.extra || typeof message.extra !== 'object') {
        message.extra = {};
    }

    if (!Array.isArray(message.extra.image_swipes)) {
        message.extra.image_swipes = [];
    }

    return message.extra.image_swipes;
}

// 默认设置
const defaultSettings = {
    insertType: INSERT_TYPE.DISABLED,
    streamGeneration: true,
    promptInjection: {
        enabled: true,
        prompt: `<image_generation>
You must insert a <pic prompt="example prompt"> at end of the reply. Prompts are used for stable diffusion image generation, based on the plot and character to output appropriate prompts to generate captivating images.
</image_generation>`,
        regex: '/<pic[^>]*\\sprompt="([^"]*)"[^>]*?>/g',
        position: 'deep_system', // deep_system, deep_user, deep_assistant
        depth: 0, // 0表示添加到末尾，>0表示从末尾往前数第几个位置
    },
};

// 从设置更新UI
function updateUI() {
    // 根据insertType设置开关状态
    $('#auto_generation').toggleClass(
        'selected',
        extension_settings[extensionName].insertType !== INSERT_TYPE.DISABLED,
    );

    // 只在表单元素存在时更新它们
    if ($('#image_generation_insert_type').length) {
        $('#image_generation_insert_type').val(
            extension_settings[extensionName].insertType,
        );
        $('#stream_generation_enabled').prop(
            'checked',
            extension_settings[extensionName].streamGeneration,
        );
        $('#prompt_injection_enabled').prop(
            'checked',
            extension_settings[extensionName].promptInjection.enabled,
        );
        $('#prompt_injection_text').val(
            extension_settings[extensionName].promptInjection.prompt,
        );
        $('#prompt_injection_regex').val(
            extension_settings[extensionName].promptInjection.regex,
        );
        $('#prompt_injection_position').val(
            extension_settings[extensionName].promptInjection.position,
        );
        $('#prompt_injection_depth').val(
            extension_settings[extensionName].promptInjection.depth,
        );
    }
}

// 加载设置
async function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};

    // 如果设置为空或缺少必要属性，使用默认设置
    if (Object.keys(extension_settings[extensionName]).length === 0) {
        Object.assign(extension_settings[extensionName], defaultSettings);
    } else {
        // 确保promptInjection对象存在
        if (!extension_settings[extensionName].promptInjection) {
            extension_settings[extensionName].promptInjection =
                defaultSettings.promptInjection;
        } else {
            // 确保promptInjection的所有子属性都存在
            const defaultPromptInjection = defaultSettings.promptInjection;
            for (const key in defaultPromptInjection) {
                if (
                    extension_settings[extensionName].promptInjection[key] ===
                    undefined
                ) {
                    extension_settings[extensionName].promptInjection[key] =
                        defaultPromptInjection[key];
                }
            }
        }

        // 确保insertType属性存在
        if (extension_settings[extensionName].insertType === undefined) {
            extension_settings[extensionName].insertType =
                defaultSettings.insertType;
        }

        // 确保streamGeneration属性存在
        if (extension_settings[extensionName].streamGeneration === undefined) {
            extension_settings[extensionName].streamGeneration =
                defaultSettings.streamGeneration;
        }
    }

    updateUI();
}

// 创建设置页面
async function createSettings(settingsHtml) {
    // 创建一个容器来存放设置，确保其正确显示在扩展设置面板中
    if (!$('#image_auto_generation_container').length) {
        $('#extensions_settings2').append(
            '<div id="image_auto_generation_container" class="extension_container"></div>',
        );
    }

    // 使用传入的settingsHtml而不是重新获取
    $('#image_auto_generation_container').empty().append(settingsHtml);

    // 添加设置变更事件处理
    $('#image_generation_insert_type').on('change', function () {
        const newValue = $(this).val();
        extension_settings[extensionName].insertType = newValue;
        updateUI();
        saveSettingsDebounced();
    });

    $('#stream_generation_enabled').on('change', function () {
        extension_settings[extensionName].streamGeneration =
            $(this).prop('checked');
        saveSettingsDebounced();
    });

    // 添加提示词注入设置的事件处理
    $('#prompt_injection_enabled').on('change', function () {
        extension_settings[extensionName].promptInjection.enabled =
            $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#prompt_injection_text').on('input', function () {
        extension_settings[extensionName].promptInjection.prompt =
            $(this).val();
        saveSettingsDebounced();
    });

    $('#prompt_injection_regex').on('input', function () {
        extension_settings[extensionName].promptInjection.regex = $(this).val();
        saveSettingsDebounced();
    });

    $('#prompt_injection_position').on('change', function () {
        extension_settings[extensionName].promptInjection.position =
            $(this).val();
        saveSettingsDebounced();
    });

    // 深度设置事件处理
    $('#prompt_injection_depth').on('input', function () {
        const value = parseInt(String($(this).val()));
        extension_settings[extensionName].promptInjection.depth = isNaN(value)
            ? 0
            : value;
        saveSettingsDebounced();
    });

    // 初始化设置值
    updateUI();
}

// 设置变更处理函数
function onExtensionButtonClick() {
    // 直接访问扩展设置面板
    const extensionsDrawer = $('#extensions-settings-button .drawer-toggle');

    // 如果抽屉是关闭的，点击打开它
    if ($('#rm_extensions_block').hasClass('closedDrawer')) {
        extensionsDrawer.trigger('click');
    }

    // 等待抽屉打开后滚动到我们的设置容器
    setTimeout(() => {
        // 找到我们的设置容器
        const container = $('#image_auto_generation_container');
        if (container.length) {
            // 滚动到设置面板位置
            $('#rm_extensions_block').animate(
                {
                    scrollTop:
                        container.offset().top -
                        $('#rm_extensions_block').offset().top +
                        $('#rm_extensions_block').scrollTop(),
                },
                500,
            );

            // 使用SillyTavern原生的抽屉展开方式
            // 检查抽屉内容是否可见
            const drawerContent = container.find('.inline-drawer-content');
            const drawerHeader = container.find('.inline-drawer-header');

            // 只有当内容被隐藏时才触发展开
            if (drawerContent.is(':hidden') && drawerHeader.length) {
                // 直接使用原生点击事件触发，而不做任何内部处理
                drawerHeader.trigger('click');
            }
        }
    }, 500);
}

// 初始化扩展
$(function () {
    (async function () {
        // 获取设置HTML (只获取一次)
        const settingsHtml = await $.get(
            `${extensionFolderPath}/settings.html`,
        );

        // 添加扩展到菜单
        $('#extensionsMenu')
            .append(`<div id="auto_generation" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-robot"></div>
            <span data-i18n="Image Auto Generation">Image Auto Generation</span>
        </div>`);

        // 修改点击事件，打开设置面板而不是切换状态
        $('#auto_generation').off('click').on('click', onExtensionButtonClick);

        await loadSettings();

        // 创建设置 - 将获取的HTML传递给createSettings
        await createSettings(settingsHtml);

        // 确保设置面板可见时，设置值是正确的
        $('#extensions-settings-button').on('click', function () {
            setTimeout(() => {
                updateUI();
            }, 200);
        });
    })();
});
// 获取消息角色
function getMesRole() {
    // 确保对象路径存在
    if (
        !extension_settings[extensionName] ||
        !extension_settings[extensionName].promptInjection ||
        !extension_settings[extensionName].promptInjection.position
    ) {
        return 'system'; // 默认返回system角色
    }

    switch (extension_settings[extensionName].promptInjection.position) {
        case 'deep_system':
            return 'system';
        case 'deep_user':
            return 'user';
        case 'deep_assistant':
            return 'assistant';
        default:
            return 'system';
    }
}

// 监听CHAT_COMPLETION_PROMPT_READY事件以注入提示词
eventSource.on(
    event_types.CHAT_COMPLETION_PROMPT_READY,
    async function (eventData) {
        try {
            // 扩展被禁用时不做任何处理
            if (
                !extension_settings[extensionName] ||
                extension_settings[extensionName].insertType ===
                    INSERT_TYPE.DISABLED
            ) {
                return;
            }

            // 行内替换模式下，将我们生成的 <img> 标签还原成模型最初输出的原始标签
            //（存放在 data-pic-gen 中，兼容用户自定义的提示词/正则格式），
            // 这样发送给模型的历史里不会出现 <img>，避免模型在多轮后学着直接输出 <img>。
            if (
                extension_settings[extensionName].insertType ===
                    INSERT_TYPE.REPLACE &&
                Array.isArray(eventData?.chat)
            ) {
                for (const entry of eventData.chat) {
                    if (
                        entry &&
                        typeof entry.content === 'string' &&
                        entry.content.includes('data-pic-gen=')
                    ) {
                        entry.content = restorePicTags(entry.content);
                    }
                }
            }

            // 提示词注入需要单独开启
            if (
                !extension_settings[extensionName].promptInjection ||
                !extension_settings[extensionName].promptInjection.enabled
            ) {
                return;
            }

            const prompt =
                extension_settings[extensionName].promptInjection.prompt;
            const depth =
                extension_settings[extensionName].promptInjection.depth || 0;
            const role = getMesRole();

            console.log(
                `[${extensionName}] 准备注入提示词: 角色=${role}, 深度=${depth}`,
            );
            console.log(
                `[${extensionName}] 提示词内容: ${prompt.substring(0, 50)}...`,
            );

            // 根据depth参数决定插入位置
            if (depth === 0) {
                // 添加到末尾
                eventData.chat.push({ role: role, content: prompt });
                console.log(`[${extensionName}] 提示词已添加到聊天末尾`);
            } else {
                // 从末尾向前插入
                eventData.chat.splice(-depth, 0, {
                    role: role,
                    content: prompt,
                });
                console.log(
                    `[${extensionName}] 提示词已插入到聊天中，从末尾往前第 ${depth} 个位置`,
                );
            }
        } catch (error) {
            console.error(`[${extensionName}] 提示词注入错误:`, error);
            toastr.error(`提示词注入错误: ${error}`);
        }
    },
);

/**
 * @typedef {object} ImageJob
 * @property {string} tag The tag as it appears in message.mes
 * @property {string} prompt The prompt captured from the tag
 * @property {string} [imageTag] REPLACE mode: the finished <img> tag
 */

/**
 * The image tags found in one message.
 * @typedef {object} ImageSession
 * @property {any} message The chat message the tags belong to
 * @property {any} processor The StreamingProcessor writing the message, if any
 * @property {Map<string, ImageJob>} jobs Jobs by tag; identical tags share an image
 * @property {string} [scannedText] The text the last stream scan looked at
 * @property {boolean} cancelled Set when a swipe has replaced the message text
 */

// The session of the message being streamed (or the last one that was)
/** @type {ImageSession|null} */
let streamSession = null;
// One image at a time: the sd command swaps global dimensions while it runs
let imageQueue = Promise.resolve();
let pendingImageCount = 0;
let generatedImageCount = 0;

/**
 * @param {any} message
 * @param {any} [processor]
 * @returns {ImageSession}
 */
function createImageSession(message, processor = null) {
    return { message, processor, jobs: new Map(), cancelled: false };
}

/**
 * While this is true ST rewrites message.mes on every tick, so anything written
 * to it would be lost.
 * @param {ImageSession} session
 * @returns {boolean}
 */
function isSessionStreaming({ processor }) {
    return !!processor && !processor.isFinished && !processor.isStopped;
}

/**
 * @param {string} text
 * @returns {RegExpMatchArray[]}
 */
function findImageTags(text) {
    // 使用正则表达式search
    const imgTagRegex = regexFromString(
        extension_settings[extensionName].promptInjection.regex,
    );
    if (!imgTagRegex) {
        return [];
    }
    const searchText = text.replace(GENERATED_IMAGE_REGEX, '');
    const unclosedTags = [...searchText.matchAll(UNCLOSED_TAG_REGEX)];
    const closedText = searchText.replace(UNCLOSED_TAG_REGEX, '');
    if (imgTagRegex.global) {
        return [...unclosedTags, ...closedText.matchAll(imgTagRegex)];
    }
    const singleMatch = closedText.match(imgTagRegex);
    return singleMatch ? [...unclosedTags, singleMatch] : unclosedTags;
}

/**
 * Swaps the tags of finished REPLACE jobs for their <img> tags.
 * @param {string} text
 * @param {Map<string, ImageJob>} jobs
 * @returns {string}
 */
function substituteImageTags(text, jobs) {
    for (const { tag, imageTag } of jobs.values()) {
        if (imageTag) {
            text = text
                .split(GENERATED_IMAGE_REGEX)
                .map((part, index) =>
                    // Odd parts are the generated tags. The replacer function
                    // keeps "$" in the prompt literal.
                    index % 2 ? part : part.replaceAll(tag, () => imageTag),
                )
                .join('');
        }
    }
    return text;
}

/**
 * Writes the finished REPLACE images into message.mes and saves them.
 * @param {ImageSession} session
 */
async function commitReplacedImages({ message, jobs }) {
    const messageId = chat.indexOf(message);
    const replaced = substituteImageTags(message.mes, jobs);
    if (messageId === -1 || replaced === message.mes) {
        return;
    }
    message.mes = replaced;

    // Update the message display using updateMessageBlock
    updateMessageBlock(messageId, message);
    await eventSource.emit(event_types.MESSAGE_UPDATED, messageId);

    // Save the chat
    await getContext().saveChat();
}

/**
 * Adds a generated image to the media of a message.
 * @param {any} message
 * @param {string} prompt
 * @param {string} imageUrl
 */
function insertInlineImage(message, prompt, imageUrl) {
    // 统一插入到extra里
    const imageSwipes = ensureImageSwipes(message);

    // 如果已有图片，添加到swipes（新版ST的extra.media已包含这些图片）
    if (
        !Array.isArray(message.extra.media) &&
        message.extra.image &&
        !imageSwipes.includes(message.extra.image)
    ) {
        imageSwipes.push(message.extra.image);
    }

    // 添加图片到swipes数组
    imageSwipes.push(imageUrl);

    // 设置第一张图片为主图片，或更新为最新生成的图片
    message.extra.image = imageUrl;
    message.extra.title = prompt;
    message.extra.inline_image = true;

    // 更新UI
    appendMediaToMessage(
        message,
        $(`.mes[mesid="${chat.indexOf(message)}"]`),
    );
}

/**
 * Generates one queued image and puts it in the message.
 * @param {ImageSession} session
 * @param {ImageJob} job
 */
async function runImageJob(session, job) {
    const isSessionGone = () =>
        session.cancelled || !chat.includes(session.message);

    try {
        const insertType = extension_settings[extensionName].insertType;
        if (insertType === INSERT_TYPE.DISABLED || isSessionGone()) {
            return;
        }

        // @ts-ignore
        const imageUrl = await SlashCommandParser.commands['sd'].callback(
            {
                quiet: insertType === INSERT_TYPE.NEW_MESSAGE ? 'false' : 'true',
            },
            job.prompt,
        );
        if (typeof imageUrl !== 'string' || imageUrl.trim().length === 0) {
            return;
        }
        generatedImageCount++;
        if (isSessionGone()) {
            return;
        }

        // During a stream ST saves the chat itself once the stream ends
        if (insertType === INSERT_TYPE.INLINE) {
            insertInlineImage(session.message, job.prompt, imageUrl);
            if (!isSessionStreaming(session)) {
                await getContext().saveChat();
            }
        } else if (insertType === INSERT_TYPE.REPLACE) {
            // Stash the original tag verbatim in data-pic-gen so we can restore
            // it later regardless of the user's custom prompt/regex format.
            const escapedUrl = escapeHtmlAttribute(imageUrl);
            const escapedPrompt = escapeHtmlAttribute(job.prompt);
            const escapedOriginalTag = escapeHtmlAttribute(job.tag);
            job.imageTag = `<img src="${escapedUrl}" title="${escapedPrompt}" alt="${escapedPrompt}" data-pic-gen="${escapedOriginalTag}">`;

            // Mid-stream, the next tick renders it through renderImageTags
            if (!isSessionStreaming(session)) {
                await commitReplacedImages(session);
            }
        }
    } catch (error) {
        toastr.error(`Image generation error: ${error}`);
        console.error('Image generation error:', error);
    } finally {
        if (--pendingImageCount === 0 && generatedImageCount > 0) {
            toastr.success(
                `${generatedImageCount} images generated successfully`,
            );
        }
    }
}

/**
 * Queues generation for the matched tags the session hasn't seen yet.
 * @param {ImageSession} session
 * @param {RegExpMatchArray[]} matches
 */
function enqueueImageTags(session, matches) {
    for (const match of matches) {
        const tag = typeof match?.[0] === 'string' ? match[0] : '';
        const prompt = typeof match?.[1] === 'string' ? match[1] : '';
        if (!tag || !prompt.trim() || session.jobs.has(tag)) {
            continue;
        }

        const job = { tag, prompt };
        session.jobs.set(tag, job);

        if (pendingImageCount++ === 0) {
            generatedImageCount = 0;
            toastr.info('Generating images...');
        }
        imageQueue = imageQueue.then(() => runImageJob(session, job));
    }
}

/**
 * Finds the session for a stream that is writing to the given message.
 * @param {any} processor
 * @param {any} message
 * @returns {ImageSession}
 */
function getStreamSession(processor, message) {
    if (streamSession?.processor === processor) {
        return streamSession;
    }

    const previous = streamSession?.message === message ? streamSession : null;
    if (processor.type === 'continue') {
        // Keep the earlier jobs: ST writes the old text back on every tick, so
        // their images still need rendering and committing. Tags already in the
        // message have been handled, so must not generate again.
        streamSession = previous ?? createImageSession(message);
        streamSession.processor = processor;
        for (const [tag] of findImageTags(message.mes)) {
            if (!streamSession.jobs.has(tag)) {
                streamSession.jobs.set(tag, { tag, prompt: '' });
            }
        }
        return streamSession;
    }

    // A swipe replaces the text, so images for the old text are no longer wanted
    if (previous) {
        previous.cancelled = true;
    }
    streamSession = createImageSession(message, processor);
    return streamSession;
}

// 流式传输时一旦检测到完整标签就开始生成图片
eventSource.on(event_types.STREAM_TOKEN_RECEIVED, handleStreamToken);
function handleStreamToken() {
    const settings = extension_settings[extensionName];
    if (
        !settings?.streamGeneration ||
        !settings.promptInjection?.regex ||
        // Create New Message posts to the chat, which would put the image in
        // the middle of the message still being streamed: wait for it to end.
        ![INSERT_TYPE.INLINE, INSERT_TYPE.REPLACE].includes(settings.insertType)
    ) {
        return;
    }

    const processor = streamingProcessor;
    const message = chat[processor?.messageId];
    if (!message || processor.type === 'impersonate') {
        return;
    }

    const session = getStreamSession(processor, message);

    // message.mes rather than the raw stream text: it has reasoning stripped, so
    // tags in <think> don't count, and its tags match the final message.
    const text = message.mes;
    if (session.scannedText === text) {
        return;
    }
    session.scannedText = text;

    // A match touching the end of the text may not be final: it could still be
    // growing, or end on a quote ST added to balance an unfinished one.
    enqueueImageTags(
        session,
        findImageTags(text).filter(
            (match) => match.index + match[0].length < match.input.length,
        ),
    );
}

/**
 * Shows finished REPLACE images while message.mes still holds the tags, without
 * changing the text itself. Tags that are unclosed get closed for display, since
 * the browser would take the text up to the next quote as part of the tag and hide
 * it, for as long as the tag is there: until its image is ready, or for good.
 * @param {string} mes
 * @param {{ messageId: number, isReasoning: boolean }} ctx
 * @returns {string}
 */
function renderImageTags(mes, ctx) {
    if (ctx.isReasoning) {
        return mes;
    }
    const text =
        chat[ctx.messageId] === streamSession?.message
            ? substituteImageTags(mes, streamSession.jobs)
            : mes;
    return text.replace(UNCLOSED_TAG_REGEX, '<pic prompt="$1">');
}

// Not available on older ST: there, images appear when the stream ends
const { messageFormatter } = getContext();
messageFormatter?.addHook(renderImageTags, {
    stage: messageFormatter.stage.BEFORE_REGEX,
});

// 监听消息接收事件
eventSource.on(event_types.MESSAGE_RECEIVED, handleIncomingMessage);
async function handleIncomingMessage() {
    // 确保设置对象存在
    if (
        !extension_settings[extensionName] ||
        extension_settings[extensionName].insertType === INSERT_TYPE.DISABLED
    ) {
        return;
    }

    // 确保promptInjection对象和regex属性存在
    if (
        !extension_settings[extensionName].promptInjection ||
        !extension_settings[extensionName].promptInjection.regex
    ) {
        console.error('Prompt injection settings not properly initialized');
        return;
    }

    const isStreamedMessage =
        !!streamingProcessor &&
        streamSession?.processor === streamingProcessor &&
        !isSessionStreaming(streamSession);
    const session = isStreamedMessage
        ? streamSession
        : createImageSession(chat[chat.length - 1]);

    // 检查是否是AI消息
    if (!session.message || session.message.is_user) {
        return;
    }

    enqueueImageTags(session, findImageTags(session.message.mes));

    // ST has just rewritten message.mes for the last time, so images that were
    // only being rendered can now go in for good.
    await commitReplacedImages(session);
}
