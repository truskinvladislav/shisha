require("dotenv").config();
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input");

// Парсим параметры из .env
const apiId = parseInt(process.env.API_ID, 10);
const apiHash = process.env.API_HASH;
let stringSession = process.env.STRING_SESSION || "";

const logGroupTitle = process.env.LOG_GROUP_TITLE;     // куда логировать
const rawFolder = process.env.TARGET_FOLDER_ID;        // id папки с группами для рекламы
const targetFolderId = rawFolder ? parseInt(rawFolder, 10) : null;

if (!apiId || !apiHash) {
    console.error('Отсутствуют API_ID или API_HASH в .env');
    process.exit(1);
}

const client = new TelegramClient(new StringSession(stringSession), apiId, apiHash, { connectionRetries: 5 });

let resolvedLogPeer = null; // id группы для логов

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function resolveDialogPeer(identifier) {
    if (!identifier) return null;
    if (/^-?\d+$/.test(String(identifier).trim())) {
        return Number(identifier);
    }
    const dialogs = await client.getDialogs();
    const found = dialogs.find(d => d.title === identifier || d.username === identifier || String(d.id) === identifier);
    return found ? found.id : null;
}

async function sendToGroup(groupIdentifier, text) {
    try {
        let peer = groupIdentifier;

        if (groupIdentifier === logGroupTitle && resolvedLogPeer) peer = resolvedLogPeer;
        else if (typeof groupIdentifier === "string" && /^-?\d+$/.test(groupIdentifier.trim())) {
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

// Основная функция рассылки рекламы из Избранного в группы из папки TARGET_FOLDER_ID
async function broadcastFromMe() {
    let currentIndex = 0;

    while (true) {
        try {
            const dialogs = await client.getDialogs();
            const groups = dialogs.filter(d => (d.isGroup || d.isChannel) && d.folderId === targetFolderId);

            if (!groups.length) {
                console.log("⚠ Нет групп в папке TARGET_FOLDER_ID");
                await sleep(60000);
                continue;
            }

            const lastMessage = (await client.getMessages("me", { limit: 1 }))[0];
            if (!lastMessage) {
                console.log("⚠ Нет сообщений в Избранном");
                await sleep(60000);
                continue;
            }

            const group = groups[currentIndex % groups.length];

            try {
                const forwardedArr = await client.forwardMessages(group.entity, {
                    messages: [lastMessage.id],
                    fromPeer: "me"
                });

                const forwarded = Array.isArray(forwardedArr) ? forwardedArr[0] : forwardedArr;
                const msgIdToDelete = forwarded?.id;

                let groupLink;
                if (group.username) {
                    groupLink = `https://t.me/${group.username}`;
                } else if (group.id) {
                    groupLink = `ID группы: ${group.id}`;
                } else {
                    groupLink = "[не удалось определить ссылку]";
                }

                const logText = `✅ Переслано сообщение в "${group.title}"\n${groupLink}\n🆔 ID сообщения: ${lastMessage.id}`;


                if (resolvedLogPeer) await sendToGroup(resolvedLogPeer, logText);
                else await sendToGroup(logGroupTitle, logText);

                if (msgIdToDelete) {
                    setTimeout(async () => {
                        try {
                            await client.deleteMessages(group.id, [msgIdToDelete]);
                            console.log(`🗑 Сообщение удалено из "${group.title}"`);
                        } catch (err) {
                            console.error(`Ошибка удаления сообщения из "${group.title}":`, err);
                        }
                    }, 60 * 1000);
                }
            } catch (err) {
                console.error(`Ошибка пересылки в "${group.title}":`, err);
                if (lastMessage.message) {
                    await client.sendMessage(group.id, { message: lastMessage.message });
                }
            }

            currentIndex++;
            console.log("⏱ Жду 3 минуты до следующей группы...");
            await sleep(3 * 60 * 1000);
        } catch (err) {
            console.error("Ошибка в broadcastFromMe:", err);
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
        if (resolvedLogPeer) console.log("🔎 LOG_GROUP_TITLE резолвлен в id:", resolvedLogPeer);
        else console.warn("⚠ LOG_GROUP_TITLE не найден по title/username. Можно указать ID в LOG_GROUP_TITLE в .env");
    }
}

(async () => {
    await startClient();
    broadcastFromMe();
})();


