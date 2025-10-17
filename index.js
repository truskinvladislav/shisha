require("dotenv").config();
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input");

const apiId = parseInt(process.env.API_ID, 10);
const apiHash = process.env.API_HASH;
let stringSession = process.env.STRING_SESSION || "";

const logGroupTitle = process.env.LOG_GROUP_TITLE;
const rawFolder = process.env.TARGET_FOLDER_ID;
const targetFolderId = rawFolder ? parseInt(rawFolder, 10) : null;

if (!apiId || !apiHash) {
    console.error('❌ Отсутствуют API_ID или API_HASH в .env');
    process.exit(1);
}

const client = new TelegramClient(new StringSession(stringSession), apiId, apiHash, { connectionRetries: 5 });

let resolvedLogPeer = null;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function resolveDialogPeer(identifier) {
    if (!identifier) return null;
    if (/^-?\d+$/.test(String(identifier).trim())) return Number(identifier);
    const dialogs = await client.getDialogs();
    const found = dialogs.find(d => d.title === identifier || d.username === identifier || String(d.id) === identifier);
    return found ? found.id : null;
}

async function sendToGroup(groupIdentifier, text) {
    try {
        let peer = groupIdentifier;
        if (groupIdentifier === logGroupTitle && resolvedLogPeer) {
            peer = resolvedLogPeer;
        } else if (typeof groupIdentifier === "string" && /^-?\d+$/.test(groupIdentifier.trim())) {
            peer = Number(groupIdentifier);
        } else if (typeof groupIdentifier === "string") {
            const dialogs = await client.getDialogs();
            const found = dialogs.find(d => d.title === groupIdentifier || d.username === groupIdentifier);
            if (found) peer = found.id;
        }

        await client.sendMessage(peer, { message: text });
    } catch (err) {
        console.error(`Ошибка при отправке в "${groupIdentifier}":`, err);
    }
}

async function logError(context, error) {
    const message = `❌ Ошибка в: ${context}\n\n${error?.message || error}\nКод ошибки: ${error?.errorMessage || "N/A"}`;
    console.error(message);
    if (resolvedLogPeer) {
        await sendToGroup(resolvedLogPeer, message);
    }
}

// Храним текущий прогресс
let sentGroupIds = new Set();

async function broadcastFromMe() {
    while (true) {
        try {
            const dialogs = await client.getDialogs();
            let groups = dialogs.filter(d => (d.isGroup || d.isChannel) && d.folderId === targetFolderId);

            // Удаление дубликатов по ID
            const uniqueMap = new Map();
            groups.forEach(g => uniqueMap.set(g.id, g));
            groups = Array.from(uniqueMap.values());

            if (!groups.length) {
                await logError("broadcastFromMe", "⚠ Нет групп в папке TARGET_FOLDER_ID");
                await sleep(60000);
                continue;
            }

            // Получаем последнее сообщение
            const lastMessage = (await client.getMessages("me", { limit: 1 }))[0];
            if (!lastMessage) {
                await logError("broadcastFromMe", "⚠ Нет сообщений в Избранном");
                await sleep(60000);
                continue;
            }

            // Фильтруем те, в которые ещё не отправляли в этом цикле
            const unsentGroups = groups.filter(group => !sentGroupIds.has(group.id.toString()));

            if (unsentGroups.length === 0) {
                console.log("🔁 Все группы обработаны. Начинаем новый круг...");
                sentGroupIds.clear();
                await sleep(5000);
                continue;
            }

            const group = unsentGroups[0];

            try {
                const forwardedArr = await client.forwardMessages(group.entity, {
                    messages: [lastMessage.id],
                    fromPeer: "me"
                });

                const forwarded = Array.isArray(forwardedArr) ? forwardedArr[0] : forwardedArr;

                let groupLink = group.username
                    ? `https://t.me/${group.username}`
                    : `ID группы: ${group.id}`;

                const logText = `✅ Переслано сообщение в "${group.title}"\n${groupLink}\n🆔 ID сообщения: ${lastMessage.id}`;
                await sendToGroup(resolvedLogPeer, logText);

                sentGroupIds.add(group.id.toString());

            } catch (err) {
                await logError(`пересылке в "${group.title}"`, err);
                try {
                    await client.sendMessage(group.id, { message: lastMessage.message });
                    sentGroupIds.add(group.id.toString());
                } catch (sendErr) {
                    await logError(`ручной отправке в "${group.title}"`, sendErr);
                }
            }

            console.log(`⏱ Жду 3 минуты до следующей группы...`);
            await sleep(3 * 60 * 1000);

        } catch (err) {
            await logError("broadcastFromMe", err);
            await sleep(20000);
        }
    }
}

async function startClient() {
    if (!stringSession || stringSession.trim() === "") {
        await client.start({
            phoneNumber: async () => await input.text("Введите номер телефона: "),
            password: async () => await input.text("Введите пароль (2FA): "),
            phoneCode: async () => await input.text("Введите код из Telegram: "),
            onError: (err) => console.log(err),
        });
        stringSession = client.session.save();
        console.log("✅ UserBot запущен! Скопируй STRING_SESSION в .env");
        console.log(stringSession);
    } else {
        await client.connect();
        console.log("✅ UserBot подключен с существующей сессией!");
    }

    if (logGroupTitle) {
        resolvedLogPeer = await resolveDialogPeer(logGroupTitle);
        if (resolvedLogPeer) {
            console.log("🔎 LOG_GROUP_TITLE резолвлен в id:", resolvedLogPeer);
        } else {
            console.warn("⚠ LOG_GROUP_TITLE не найден. Укажи ID или точное имя в .env");
        }
    }
}

(async () => {
    await startClient();
    broadcastFromMe();
})();
