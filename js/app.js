// ========== 常量配置 ==========
const STATUS_LIST = [
    { key: 'pending',     label: '待制作', class: 'status-pending' },
    { key: 'making',      label: '制作中', class: 'status-making' },
    { key: 'revise',      label: '待修改', class: 'status-revise' },
    { key: 'delivered',   label: '已交付', class: 'status-delivered' },
    { key: 'done',        label: '已完成', class: 'status-done' },
    { key: 'cancel',      label: '已取消', class: 'status-cancel' },
];
const STATUS_MAP = {};
STATUS_LIST.forEach(s => STATUS_MAP[s.key] = s);

// ========== Firebase 初始化 ==========
const FB_CONFIG = {
    apiKey: "AIzaSyDS8jEcdPzYcDiDRZpvopMM6qxX1t6nNzU",
    authDomain: "order-management-62810.firebaseapp.com",
    projectId: "order-management-62810",
    storageBucket: "order-management-62810.appspot.com",
    messagingSenderId: "512745227925",
    appId: "1:512745227925:web:7a3a27b3d44a7c8e3a371c"
};

let firebaseApp, fbAuth, fbFirestore = null;
let storageMode = 'none';     // 'cloud' | 'local'
let currentUserId = null;     // uid (Firebase) 或 'local'
let snapshotUnsubscribe = null;
let firestoreReady = false;   // 防 onAuthStateChanged 重复触发
let authInitDone = false;     // 标识首次 auth 初始化完成，避免闪烁
let cloudInitError = null;    // 云端初始化失败时的错误信息

// Firebase 初始化（带异常保护）——无论能否连接，页面都要能打开
try {
    if (typeof firebase !== 'undefined') {
        firebaseApp = firebase.initializeApp(FB_CONFIG);
        fbAuth = firebaseApp.auth();
        fbFirestore = firebaseApp.firestore();
    } else {
        cloudInitError = 'Firebase SDK 未加载（网络/浏览器策略）';
    }
} catch (e) {
    cloudInitError = (e && e.message) ? e.message : String(e);
    console.warn('Firebase 初始化失败，降级为本机模式：', cloudInitError);
    fbAuth = null;
    fbFirestore = null;
}

// ========== 全局状态 ==========
let state = {
    orders: [],
    shops: ['露露', 'wang', '萝萝'],  // 店铺列表
    currentPage: 'dashboard',
    currentFilter: 'all',
    currentSearch: '',
    syncStatus: 'idle',  // idle | syncing | synced | error
};

// ========== 工具函数 ==========
function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function formatMoney(amount) {
    const num = Number(amount) || 0;
    return '¥' + num.toLocaleString('zh-CN');
}

function formatDate(ts) {
    if (!ts) return '-';
    const d = tsToDate(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDateTime(ts) {
    if (!ts) return '-';
    const d = tsToDate(ts);
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function tsToDate(ts) {
    // ts 可能是 number 或 Firestore Timestamp 或 Date
    if (ts instanceof Date) return ts;
    if (ts && typeof ts.toDate === 'function') return ts.toDate();
    if (ts && ts.seconds != null) return new Date(ts.seconds * 1000 + (ts.nanoseconds || 0) / 1e6);
    return new Date(Number(ts) || 0);
}

function tsToNumber(ts) {
    if (!ts) return 0;
    return tsToDate(ts).getTime();
}

function daysBetween(a, b) {
    return Math.floor((b - a) / 86400000);
}

function getUnpaidAmount(order) {
    return (Number(order.price) || 0) - (Number(order.paidAmount) || 0);
}

function isUnpaid(order) {
    return getUnpaidAmount(order) > 0 && order.status !== 'cancel';
}

function getOverdueLevel(order) {
    if (order.status !== 'delivered') return 0;
    if (!isUnpaid(order)) return 0;
    const ref = tsToNumber(order.deliveredAt || order.updatedAt || order.createdAt);
    const days = daysBetween(ref, Date.now());
    if (days >= 10) return 3;
    if (days >= 7) return 2;
    if (days >= 3) return 1;
    return 0;
}

function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function showToast(msg, duration = 1800) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.remove('show'), duration);
}

function setAuthMsg(msg) {
    const el = document.getElementById('auth-msg');
    if (el) el.textContent = msg || '';
}

function updateDataInfo() {
    const info = document.getElementById('data-info');
    if (!info) return;
    let txt = '';
    if (storageMode === 'cloud') {
        txt = `共 ${state.orders.length} 个订单 · 云端同步 ${state.syncStatus === 'syncing' ? '（同步中…）' : '✓'}`;
    } else if (storageMode === 'local') {
        txt = `共 ${state.orders.length} 个订单 · 本机存储`;
    } else {
        txt = '';
    }
    info.textContent = txt;
}

// ========== 认证（Auth） ==========
function signIn() {
    if (!fbAuth) { showToast('Firebase 未加载'); return; }
    const email = document.getElementById('auth-email').value.trim();
    const pwd = document.getElementById('auth-password').value;
    if (!email || !pwd) { setAuthMsg('请输入邮箱和密码'); return; }
    setAuthMsg('登录中…');
    fbAuth.signInWithEmailAndPassword(email, pwd)
        .then(() => setAuthMsg(''))
        .catch(err => {
            let msg = err.message || '登录失败';
            if (err.code === 'auth/user-not-found') msg = '该邮箱未注册，请先注册';
            else if (err.code === 'auth/wrong-password') msg = '密码错误';
            else if (err.code === 'auth/invalid-email') msg = '邮箱格式不正确';
            setAuthMsg(msg);
        });
}

function signUp() {
    if (!fbAuth) { showToast('Firebase 未加载'); return; }
    const email = document.getElementById('auth-email').value.trim();
    const pwd = document.getElementById('auth-password').value;
    if (!email || !pwd) { setAuthMsg('请输入邮箱和密码'); return; }
    if (pwd.length < 6) { setAuthMsg('密码至少 6 位'); return; }
    setAuthMsg('注册中…');
    fbAuth.createUserWithEmailAndPassword(email, pwd)
        .then(() => setAuthMsg(''))
        .catch(err => {
            let msg = err.message || '注册失败';
            if (err.code === 'auth/email-already-in-use') msg = '该邮箱已注册，请直接登录';
            else if (err.code === 'auth/weak-password') msg = '密码太弱，请至少 6 位';
            setAuthMsg(msg);
        });
}

function signOut() {
    // 退出时同时清理本机模式的持久化标记（下次启动会正常询问登录/本机）
    try { localStorage.removeItem('order-mgr-explicit-local'); } catch(e){}
    if (!fbAuth) {
        // 匿名模式下也能退出：切回登录页
        switchToAuthScreen();
        return;
    }
    if (!confirm('确认退出登录？')) return;
    fbAuth.signOut().then(() => {
        showToast('已退出');
    }).catch(() => {});
}

function signInAnon() {
    // 不登录，继续使用本地 LocalStorage（保持旧行为）
    storageMode = 'local';
    currentUserId = 'local';
    // 持久化"用户明确选择过本机模式"，下次刷新不再弹出登录页
    try { localStorage.setItem('order-mgr-explicit-local', '1'); } catch(e){}
    switchToAppScreen();
    loadFromLocalStorage();
    // 首次加载空数据时，展示仪表盘
    navigate('dashboard');
    showToast('本机模式（不同步到云端）');
    updateDataInfo();
}

function hideBootLoader() {
    const el = document.getElementById('boot-loader');
    if (el) { el.style.display = 'none'; }
}

function switchToAuthScreen() {
    storageMode = 'none';
    currentUserId = null;
    if (snapshotUnsubscribe) { try { snapshotUnsubscribe(); } catch(e){} snapshotUnsubscribe = null; }
    const auth = document.getElementById('auth-screen');
    const app = document.getElementById('app');
    if (auth) auth.style.display = 'flex';
    if (app) app.style.display = 'none';
    setAuthMsg('');
    hideBootLoader();
}

function switchToAppScreen() {
    const auth = document.getElementById('auth-screen');
    const app = document.getElementById('app');
    if (auth) auth.style.display = 'none';
    if (app) app.style.display = 'block';
    const info = document.getElementById('user-info');
    if (info) {
        if (storageMode === 'cloud' && currentUserId) {
            // 云端模式：显示用户信息
            info.textContent = `👤 ${currentUserId.slice(0, 6)}…`;
        } else {
            // 本机模式：显示登录按钮，点击即清空本机标记并进入登录页
            info.innerHTML = '<button class="nav-btn nav-btn-ghost" onclick="tryCloudLogin()" style="background:rgba(0,122,255,0.1);color:#007AFF;padding:6px 12px;border-radius:9px;border:none;font-weight:600;cursor:pointer;font-size:13px;">🔐 登录 / 云端同步</button>';
        }
    }
    hideBootLoader();
}

function tryCloudLogin() {
    // 从本机模式重新尝试登录：清除"已选择本机模式"标记，进入登录页
    try { localStorage.removeItem('order-mgr-explicit-local'); } catch(e){}
    switchToAuthScreen();
}

// ========== Auth 状态监听 ==========
// 核心保障：无论 Firebase 是否可用，都必须在几秒内进入页面（绝不"一直加载中"）
// 优先尊重用户"本机模式"的明确选择
let authHandledOnce = false;
let bootTimeoutMs = 2500;   // Firebase 超过这个时间仍无响应 → 先进入本机模式
const _fallbackToLocal = (reason) => {
    if (authHandledOnce) return;
    authHandledOnce = true;
    authInitDone = true;
    storageMode = 'local';
    currentUserId = 'local';
    try { localStorage.setItem('order-mgr-explicit-local', '1'); } catch(e){}
    switchToAppScreen();
    loadFromLocalStorage();
    navigate('dashboard');
    if (reason) {
        showToast('云端暂不可用：' + reason + '（已切换为本机模式）');
    } else {
        showToast('本机模式（不同步到云端）');
    }
};

// 快速通道 1：用户之前明确选择过"先不登录" → 直接进本机模式（不用等 Firebase）
try {
    if (localStorage.getItem('order-mgr-explicit-local') === '1') {
        _fallbackToLocal(null);
    }
} catch(e){}

if (!authHandledOnce && fbAuth) {
    try {
        // 启动超时：Firebase 可用，先设置超时
        const fallbackTimer = setTimeout(() => _fallbackToLocal('连接超时'), bootTimeoutMs);

        const unsub = fbAuth.onAuthStateChanged(
            user => {
                if (authHandledOnce) {
                    if (!user) {
                        switchToAuthScreen();
                    } else {
                        currentUserId = user.uid;
                        storageMode = 'cloud';
                        switchToAppScreen();
                        navigate('dashboard');
                        setupCloudRealtime();
                    }
                    return;
                }
                authHandledOnce = true;
                authInitDone = true;
                clearTimeout(fallbackTimer);

                if (user) {
                    currentUserId = user.uid;
                    storageMode = 'cloud';
                    switchToAppScreen();
                    setupCloudRealtime();
                    navigate('dashboard');
                } else {
                    switchToAuthScreen();
                }
            },
            err => {
                // onAuthStateChanged 监听异常 → 也必须保证页面可打开
                console.warn('Auth 监听异常，降级为本机模式', err);
                _fallbackToLocal('认证服务未就绪');
            }
        );
    } catch (e) {
        console.warn('绑定 onAuthStateChanged 失败', e);
        _fallbackToLocal('云端初始化失败');
    }
} else if (!authHandledOnce) {
    // Firebase SDK 完全不可用 → 立即进入本机模式
    authInitDone = true;
    signInAnon();
    hideBootLoader();
}

// ========== 数据读写层 ==========
// cloud mode：通过 Firestore onSnapshot 驱动 state.orders
// local mode：LocalStorage

function setupCloudRealtime() {
    if (!fbFirestore || !currentUserId) return;
    // 先清掉旧监听
    if (snapshotUnsubscribe) { try { snapshotUnsubscribe(); } catch(e){} snapshotUnsubscribe = null; }

    state.syncStatus = 'syncing';
    updateDataInfo();

    const col = fbFirestore.collection('users').doc(currentUserId).collection('orders');
    const q = col.orderBy('createdAt', 'desc');

    snapshotUnsubscribe = q.onSnapshot(
        snapshot => {
            const list = [];
            snapshot.forEach(doc => {
                const data = doc.data();
                // 保留文档 ID，便于更新/删除
                list.push({ ...data, _docId: doc.id });
            });
            state.orders = list;
            state.syncStatus = 'synced';
            updateDataInfo();
            // 若用户正在列表/仪表盘/详情页，刷新
            renderCurrentPage();
        },
        err => {
            console.error('Firestore 监听失败', err);
            state.syncStatus = 'error';
            showToast('云端同步失败：' + (err.message || err.code));
            updateDataInfo();
        }
    );
}

function saveToLocalStorage() {
    try {
        localStorage.setItem('order_management_data_v1', JSON.stringify({ orders: state.orders, shops: state.shops }));
    } catch (e) {
        console.error('保存本地失败', e);
    }
}

function loadFromLocalStorage() {
    try {
        const raw = localStorage.getItem('order_management_data_v1');
        if (raw) {
            const data = JSON.parse(raw);
            state.orders = data.orders || [];
            if (data.shops && Array.isArray(data.shops)) {
                state.shops = data.shops;
            }
        }
    } catch (e) {
        console.error('加载失败', e);
        state.orders = [];
    }
}

/**
 * 将订单写入 Firestore。若 order 带 _docId，则 update；否则 add 并回写 _docId。
 * 云端模式下不直接改写 state.orders（让 onSnapshot 来驱动）。
 */
function cloudWrite(order) {
    if (!fbFirestore || !currentUserId) return;
    const col = fbFirestore.collection('users').doc(currentUserId).collection('orders');
    // 准备一个纯 JSON 副本，避免把 Date/Timestamp 的递归引用写入
    const now = Date.now();
    const toSave = {
        customer: order.customer || '',
        price: Number(order.price) || 0,
        paidAmount: Number(order.paidAmount) || 0,
        status: order.status || 'pending',
        note: order.note || '',
        images: order.images || [],
        count: order.count || '',
        shop: order.shop || '',
        modifyCount: Number(order.modifyCount) || 0,
        viewLink: order.viewLink || '',
        sourceLink: order.sourceLink || '',
        paymentHistory: order.paymentHistory || [],
        createdAt: order.createdAt || now,
        updatedAt: now,
        deliveredAt: order.deliveredAt || null,
        doneAt: order.doneAt || null,
    };

    if (order._docId) {
        col.doc(order._docId).set(toSave, { merge: false })
            .catch(err => { showToast('保存失败'); console.error(err); });
    } else {
        col.add(toSave).then(ref => {
            order._docId = ref.id;
        }).catch(err => { showToast('写入失败'); console.error(err); });
    }
}

function cloudDelete(docId) {
    if (!fbFirestore || !currentUserId || !docId) return;
    fbFirestore.collection('users').doc(currentUserId).collection('orders').doc(docId).delete()
        .catch(err => { showToast('删除失败'); console.error(err); });
}

// 统一入口：创建/更新订单 —— 根据存储模式选择写入方式
function persistOrder(order) {
    if (storageMode === 'cloud') {
        cloudWrite(order);
    } else {
        // 本地模式：直接改 state.orders
        const idx = state.orders.findIndex(o => (o.id === order.id || o._docId === order._docId));
        if (idx >= 0) state.orders[idx] = order;
        else state.orders.unshift(order);
        saveToLocalStorage();
        renderCurrentPage();
    }
}

function persistDelete(order) {
    if (storageMode === 'cloud') {
        if (order._docId) cloudDelete(order._docId);
    } else {
        state.orders = state.orders.filter(o => o.id !== order.id);
        saveToLocalStorage();
        renderCurrentPage();
    }
}

// ========== 订单操作 ==========
function createOrder(data) {
    const now = Date.now();
    const order = {
        id: uid(),
        customer: data.customer || '未命名',
        price: Number(data.price) || 0,
        paidAmount: Number(data.paidAmount) || 0,
        status: data.status || 'pending',
        note: data.note || '',
        images: data.images || [],
        count: data.count || '',
        shop: data.shop || '',  // 店铺名称
        modifyCount: 0,
        viewLink: '',
        sourceLink: '',
        createdAt: now,
        updatedAt: now,
        deliveredAt: null,
        doneAt: null,
        paymentHistory: [],
    };
    persistOrder(order);
    return order;
}

function updateOrder(id, updates) {
    // 找订单（id 可能是 order.id 或 order._docId）
    const o = state.orders.find(x => x.id === id) ||
              state.orders.find(x => x._docId === id);
    if (!o) return;
    Object.assign(o, updates);
    o.updatedAt = Date.now();

    // 标记交付时间
    if (updates.status === 'delivered' && !o.deliveredAt) o.deliveredAt = o.updatedAt;
    if (updates.status && updates.status !== 'delivered') o.deliveredAt = null;

    // 收款自动切换状态
    if (getUnpaidAmount(o) <= 0 && o.status !== 'cancel' && o.paidAmount > 0) {
        o.status = 'done';
        if (!o.doneAt) o.doneAt = o.updatedAt;
    }
    persistOrder(o);
}

function recordPayment(id, amount) {
    const o = state.orders.find(x => x.id === id) ||
              state.orders.find(x => x._docId === id);
    if (!o) return false;
    const amt = Number(amount);
    if (!amt || amt <= 0) { showToast('请输入正确的金额'); return false; }
    const remaining = getUnpaidAmount(o);
    if (amt > remaining) {
        if (!confirm(`收款金额 ¥${amt} 超过未收金额 ¥${remaining}，是否继续？`)) return false;
    }
    o.paidAmount = (Number(o.paidAmount) || 0) + amt;
    o.paymentHistory = o.paymentHistory || [];
    o.paymentHistory.push({ amount: amt, at: Date.now() });
    o.updatedAt = Date.now();

    if (getUnpaidAmount(o) <= 0 && o.status !== 'cancel') {
        o.status = 'done';
        o.doneAt = o.updatedAt;
    }
    persistOrder(o);
    return true;
}

function changeStatus(id, newStatus) {
    const o = state.orders.find(x => x.id === id) ||
              state.orders.find(x => x._docId === id);
    if (!o) return;

    // 从 已完成 切回其他状态时，自动清零已收金额
    if (o.status === 'done' && newStatus !== 'done' && newStatus !== 'cancel') {
        if (confirm('订单当前为「已完成」状态，切换回去将清空已收金额，确认继续？')) {
            o.paidAmount = 0;
            o.paymentHistory = [];
            o.doneAt = null;
        } else {
            return;
        }
    }

    if (o.status === 'revise' && newStatus === 'making') {
        o.modifyCount = (o.modifyCount || 0) + 1;
    }

    o.status = newStatus;
    o.updatedAt = Date.now();
    if (newStatus === 'delivered' && !o.deliveredAt) o.deliveredAt = Date.now();
    if (newStatus !== 'delivered') o.deliveredAt = null;
    if (newStatus === 'done' && !o.doneAt) {
        o.doneAt = Date.now();
        if ((o.paidAmount || 0) < (o.price || 0)) {
            const autoAdd = (o.price || 0) - (o.paidAmount || 0);
            if (autoAdd > 0) {
                o.paymentHistory = o.paymentHistory || [];
                o.paymentHistory.push({ amount: autoAdd, at: Date.now(), auto: true });
                o.paidAmount = o.price || 0;
            }
        }
    }

    persistOrder(o);
    showToast('已切换为：' + STATUS_MAP[newStatus].label);
}

function deleteOrder(id) {
    if (!confirm('确认删除该订单？此操作不可恢复。')) return;
    const o = state.orders.find(x => x.id === id) ||
              state.orders.find(x => x._docId === id);
    if (!o) return;
    persistDelete(o);
    showToast('已删除');
    navigate('orders');
}

// ========== 路由导航 ==========
function navigate(page, param) {
    state.currentPage = page;
    state._pageParam = param;
    document.querySelectorAll('.nav-item').forEach(el => {
        el.classList.toggle('active', el.dataset.nav === page);
    });
    window.scrollTo(0, 0);
    renderCurrentPage();
}

function renderCurrentPage() {
    const main = document.getElementById('main');
    if (!main) return;
    const page = state.currentPage;
    if (page === 'dashboard') main.innerHTML = renderDashboard();
    else if (page === 'orders') main.innerHTML = renderOrders();
    else if (page === 'new') main.innerHTML = renderNewOrder();
    else if (page === 'detail') main.innerHTML = renderDetail(state._pageParam);
    else if (page === 'stats') main.innerHTML = renderStats();
    else if (page === 'settings') main.innerHTML = renderSettings();
    else main.innerHTML = '<div class="empty">页面不存在</div>';
    updateDataInfo();
}

// ========== 仪表盘 ==========
function renderDashboard() {
    const orders = state.orders;
    const countBy = (status) => orders.filter(o => o.status === status).length;
    const unpaidOrders = orders.filter(isUnpaid);
    const totalUnpaid = unpaidOrders.reduce((sum, o) => sum + getUnpaidAmount(o), 0);
    const totalRevenue = orders.reduce((s, o) => s + (Number(o.paidAmount) || 0), 0);
    const totalPrice = orders.reduce((s, o) => s + (Number(o.price) || 0), 0);

    const recent = [...orders]
        .sort((a, b) => tsToNumber(b.updatedAt) - tsToNumber(a.updatedAt));

    const overdueList = orders
        .filter(o => getOverdueLevel(o) >= 1)
        .sort((a, b) => getOverdueLevel(b) - getOverdueLevel(a));

    return `
        <div class="page-title">📊 仪表盘</div>

        <div class="stats-grid">
            <div class="stat-card" onclick="state.currentFilter='all';navigate('orders');">
                <div class="stat-label">总订单数</div>
                <div class="stat-value">${orders.length}</div>
            </div>
            <div class="stat-card" onclick="state.currentFilter='pending';navigate('orders');">
                <div class="stat-label">待制作</div>
                <div class="stat-value">${countBy('pending')}</div>
            </div>
            <div class="stat-card" onclick="state.currentFilter='revise';navigate('orders');">
                <div class="stat-label">待修改</div>
                <div class="stat-value">${countBy('revise')}</div>
            </div>
            <div class="stat-card" onclick="state.currentFilter='delivered';navigate('orders');">
                <div class="stat-label">已交付</div>
                <div class="stat-value">${countBy('delivered')}</div>
            </div>
            <div class="stat-card" onclick="state.currentFilter='done';navigate('orders');">
                <div class="stat-label">已完成</div>
                <div class="stat-value">${countBy('done')}</div>
            </div>
            <div class="stat-card highlight" onclick="state.currentFilter='unpaid';navigate('orders');">
                <div class="stat-label">待收款订单</div>
                <div class="stat-value">${unpaidOrders.length}</div>
                <div class="stat-sub">${formatMoney(totalUnpaid)}</div>
            </div>
        </div>

        ${overdueList.length > 0 ? `
        <div class="section">
            <div class="section-title">⚠️ 超期提醒 (${overdueList.length})</div>
            <div class="orders-grid">
                ${overdueList.map(o => renderOrderCard(o)).join('')}
            </div>
        </div>
        ` : ''}

        <div class="section">
            <div class="section-title">
                <span>🕓 最近更新</span>
                <a class="link" onclick="navigate('orders')">查看全部 →</a>
            </div>
            ${recent.length === 0
                ? '<div class="empty"><div class="empty-icon">📭</div><div>还没有订单，点击右上角 <b>+ 新订单</b> 创建</div></div>'
                : `<div class="orders-grid">${recent.map(o => renderOrderCard(o)).join('')}</div>`
            }
        </div>
    `;
}

// ========== 订单卡片 ==========
function renderOrderCard(order) {
    const unpaid = getUnpaidAmount(order);
    const overdueLevel = getOverdueLevel(order);
    const overdueText = ['', '已超期（3-7天）', '已超期（7-10天）', '平台可能已自动收款'][overdueLevel] || '';

    const coverImg = order.images && order.images.length > 0
        ? `<img src="${order.images[0]}" alt="平面图">`
        : `<div class="thumb-placeholder">📐</div>`;

    const statusBadge = STATUS_MAP[order.status]
        ? `<span class="status-badge ${STATUS_MAP[order.status].class}">${STATUS_MAP[order.status].label}</span>`
        : '';

    let unpaidLine = '';
    if (order.status === 'cancel') unpaidLine = '<span style="color:#999;">已取消</span>';
    else if (unpaid <= 0 && order.paidAmount > 0) unpaidLine = '<span style="color:#10b981;">✓ 已收款</span>';
    else if (unpaid > 0) unpaidLine = `<span>待收：<b>${formatMoney(unpaid)}</b></span>`;
    else unpaidLine = '<span style="color:#aaa;">未收款</span>';

    let linksBar = '';
    if (order.status === 'done') {
        const dateLabel = order.doneAt
            ? `<span style="font-size:11px;color:#6b7280;">完成：${formatDate(order.doneAt)}</span>`
            : '';
        const vBtn = order.viewLink
            ? `<a class="link" style="font-size:11px;padding:0 6px;" target="_blank" href="${escapeHtml(order.viewLink)}" onclick="event.stopPropagation()">查看 ↗</a>`
            : '';
        const sBtn = order.sourceLink
            ? `<a class="link" style="font-size:11px;padding:0 6px;" target="_blank" href="${escapeHtml(order.sourceLink)}" onclick="event.stopPropagation()">源文件 ↗</a>`
            : '';
        if (vBtn || sBtn) {
            linksBar = `<div style="margin-top:6px;padding-top:6px;border-top:1px dashed #e5e7eb;display:flex;justify-content:space-between;align-items:center;gap:4px;flex-wrap:wrap;">${dateLabel}<span style="display:flex;gap:8px;">${vBtn}${sBtn}</span></div>`;
        } else if (dateLabel) {
            linksBar = `<div style="margin-top:6px;padding-top:6px;border-top:1px dashed #e5e7eb;font-size:11px;color:#6b7280;text-align:right;">${dateLabel}</div>`;
        }
    }

    const key = order._docId || order.id;

    return `
        <div class="order-card" onclick="navigate('detail','${key}')">
            <div class="order-thumb">${coverImg}</div>
            <div class="order-body">
                <div class="order-top">
                    <div class="order-left-col">
                        <div class="order-customer">${escapeHtml(order.customer)}</div>
                        ${order.shop ? `<div class="order-shop">🏪 ${escapeHtml(order.shop)}</div>` : ''}
                    </div>
                    <div class="order-right-col">
                        <div class="order-price">${formatMoney(order.price)}</div>
                        ${statusBadge}
                    </div>
                </div>
                <div class="order-meta">
                    ${order.count ? `📦 ${escapeHtml(order.count)}` : ''}
                    ${order.modifyCount > 0 ? ` · 第${order.modifyCount}次修改` : ''}
                </div>
                <div class="order-meta">📅 ${formatDate(order.createdAt)}</div>
                <div class="order-unpaid ${unpaid>0?'':'owes'}">
                    ${unpaidLine}
                    ${overdueText ? `<div style="font-size:11px;margin-top:2px;color:#ef4444;">${overdueText}</div>` : ''}
                </div>
                ${linksBar}
            </div>
        </div>
    `;
}

// ========== 订单列表 ==========
function renderOrders() {
    return `
        <div class="page-title">📋 订单列表 (${state.orders.length})</div>

        <input type="text" class="search-box" placeholder="🔍 搜索客户昵称、备注..."
            value="${escapeHtml(state.currentSearch)}"
            oninput="state.currentSearch=this.value;updateOrderList();">

        <div class="filter-bar">
            ${['all','pending','making','revise','delivered','unpaid','done','cancel'].map(ff => {
                const labels = {all:'全部',pending:'待制作',making:'制作中',revise:'待修改',delivered:'已交付',unpaid:'待收款',done:'已完成',cancel:'已取消'};
                return `<button class="filter-btn ${state.currentFilter===ff?'active':''}" onclick="state.currentFilter='${ff}';renderCurrentPage();">${labels[ff]}</button>`;
            }).join('')}
        </div>

        <div id="order-list-container">${renderOrderListBody(filterOrders())}</div>
    `;
}

function filterOrders() {
    let list = [...state.orders];
    const f = state.currentFilter;
    if (f && f !== 'all') {
        if (f === 'unpaid') list = list.filter(isUnpaid);
        else list = list.filter(o => o.status === f);
    }
    const q = state.currentSearch.trim();
    if (q) {
        const low = q.toLowerCase();
        list = list.filter(o =>
            (o.customer || '').toLowerCase().includes(low) ||
            (o.note || '').toLowerCase().includes(low) ||
            (o.shop || '').toLowerCase().includes(low)
        );
    }
    // 排序：已完成筛选按 doneAt 倒序；其他按超期+更新时间
    if (state.currentFilter === 'done') {
        list.sort((a, b) => tsToNumber(b.doneAt || b.updatedAt) - tsToNumber(a.doneAt || a.updatedAt));
    } else {
        list.sort((a, b) => {
            const la = getOverdueLevel(a), lb = getOverdueLevel(b);
            if (la !== lb) return lb - la;
            return tsToNumber(b.updatedAt) - tsToNumber(a.updatedAt);
        });
    }
    return list;
}

function renderOrderListBody(list) {
    if (list.length === 0) {
        return '<div class="empty"><div class="empty-icon">📭</div><div>没有符合条件的订单</div></div>';
    }
    return `<div class="orders-grid">${list.map(o => renderOrderCard(o)).join('')}</div>`;
}

function updateOrderList() {
    const container = document.getElementById('order-list-container');
    if (!container) return;
    const list = filterOrders();
    container.innerHTML = renderOrderListBody(list);
    // 更新标题中的数量
    const title = document.querySelector('#main .page-title');
    if (title) title.textContent = `📋 订单列表 (${state.orders.length})`;
}

// ========== 新增订单 ==========
function renderNewOrder() {
    return `
        <div class="page-title">➕ 新增订单</div>
        <div class="form-card">
            <div class="form-group">
                <label class="form-label">客户昵称<span style="color:#ef4444;">*</span></label>
                <input class="form-input" id="new-customer" autofocus placeholder="例如：张先生">
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
                <div class="form-group">
                    <label class="form-label">报价金额 (元)<span style="color:#ef4444;">*</span></label>
                    <input class="form-input" id="new-price" type="number" min="0" step="0.01" placeholder="300">
                </div>
                <div class="form-group">
                    <label class="form-label">效果图数量</label>
                    <input class="form-input" id="new-count" placeholder="1张 / 3张">
                </div>
            </div>
            <div class="form-group">
                <label class="form-label">来源店铺</label>
                <div class="shop-selector" id="shop-selector">
                    ${state.shops.map((s, i) => `
                        <button class="shop-tag ${i === 0 ? 'active' : ''}" onclick="selectShop(this, '${escapeHtml(s)}')">${escapeHtml(s)}</button>
                    `).join('')}
                    <button class="shop-tag shop-add" onclick="showAddShopModal()">+</button>
                </div>
                <input type="hidden" id="new-shop" value="${state.shops[0] || ''}">
            </div>
            <div class="form-group">
                <label class="form-label">平面图（点击或拖拽上传，支持多张）</label>
                <div class="upload-area" onclick="document.getElementById('new-image-input').click()">
                    <div class="upload-icon">📐</div>
                    <div class="upload-text">点击上传平面图<br>支持 jpg / png / webp</div>
                </div>
                <input type="file" id="new-image-input" accept="image/*" multiple style="display:none" onchange="handleImageUpload(event, renderUploadPreview)">
                <div class="upload-preview" id="upload-preview"></div>
            </div>
            <div class="form-group">
                <label class="form-label">备注</label>
                <textarea class="form-textarea" id="new-note" placeholder="备注信息..."></textarea>
            </div>
            <div style="display:flex;gap:8px;margin-top:8px;">
                <button class="btn btn-primary" style="flex:1;padding:12px;" onclick="handleNewOrderSubmit()">✓ 创建订单</button>
            </div>
        </div>
    `;
}

// 上传图片池（临时挂在 window._pendingImages）
window._pendingImages = [];

function handleImageUpload(event, onDone) {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;
    let loaded = 0;
    files.forEach(file => {
        compressImage(file, 1200, 0.82).then(dataUrl => {
            window._pendingImages.push(dataUrl);
            loaded++;
            if (loaded === files.length) {
                showToast(`已添加 ${files.length} 张图`);
                if (typeof onDone === 'function') onDone();
            }
        });
    });
    event.target.value = '';
}

function compressImage(file, maxSize, quality) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => {
            const img = new Image();
            img.onload = () => {
                let w = img.width, h = img.height;
                if (w > maxSize || h > maxSize) {
                    if (w > h) { h = Math.round(h * maxSize / w); w = maxSize; }
                    else { w = Math.round(w * maxSize / h); h = maxSize; }
                }
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, w, h);
                const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
                resolve(canvas.toDataURL(mime, quality));
            };
            img.onerror = reject;
            img.src = e.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

function renderUploadPreview() {
    const preview = document.getElementById('upload-preview');
    if (!preview) return;
    preview.innerHTML = window._pendingImages.map((src, i) => `
        <div class="upload-preview-item">
            <img src="${src}" alt="">
            <div class="remove-btn" onclick="removePendingImage(${i})">✕</div>
        </div>
    `).join('');
}

function removePendingImage(idx) {
    window._pendingImages.splice(idx, 1);
    renderUploadPreview();
}

function handleNewOrderSubmit() {
    const customer = document.getElementById('new-customer').value.trim();
    const price = parseFloat(document.getElementById('new-price').value);
    const count = document.getElementById('new-count').value.trim();
    const note = document.getElementById('new-note').value.trim();
    const shop = document.getElementById('new-shop').value.trim();
    if (!customer) { showToast('请填写客户昵称'); return; }
    if (isNaN(price) || price < 0) { showToast('请填写正确金额'); return; }

    const order = createOrder({ customer, price, count, note, shop, images: [...window._pendingImages] });
    window._pendingImages = [];
    showToast('✓ 订单已创建');
    // 跳转到详情页（需要有 key；云端模式下 key 由 onSnapshot 生成）
    if (storageMode === 'local') {
        navigate('detail', order.id);
    } else {
        // 云端模式：onSnapshot 稍后会刷新列表，这里跳到订单列表即可
        navigate('orders');
    }
}

// ========== 店铺管理 ==========
function selectShop(btn, shopName) {
    document.querySelectorAll('.shop-tag').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('new-shop').value = shopName;
}

function showAddShopModal() {
    const html = `
        <div style="padding:16px;">
            <div style="font-weight:600;margin-bottom:12px;">添加新店铺</div>
            <input type="text" id="add-shop-name" class="form-input" placeholder="店铺名称" autofocus>
            <div style="display:flex;gap:8px;margin-top:16px;">
                <button class="btn btn-secondary" style="flex:1;" onclick="closeModal()">取消</button>
                <button class="btn btn-primary" style="flex:1;" onclick="addShop()">添加</button>
            </div>
        </div>
    `;
    showModal(html);
}

function addShop() {
    const name = document.getElementById('add-shop-name').value.trim();
    if (!name) { showToast('请输入店铺名称'); return; }
    if (state.shops.includes(name)) { showToast('店铺已存在'); return; }
    state.shops.push(name);
    save();
    closeModal();
    showToast(`✓ 已添加店铺：${name}`);
    // 如果当前在新增订单页面，重新渲染表单以显示新店铺
    if (state.currentPage === 'new') {
        renderCurrentPage();
    } else if (state.currentPage === 'settings') {
        renderCurrentPage();
    }
}

function removeShop(index) {
    const shop = state.shops[index];
    if (!confirm(`确定要删除店铺「${shop}」吗？关联的订单仍会保留该店铺名称。`)) return;
    state.shops.splice(index, 1);
    save();
    showToast(`✓ 已删除店铺：${shop}`);
    if (state.currentPage === 'settings') {
        renderCurrentPage();
    }
}

// ========== 订单详情 ==========
function renderDetail(id) {
    const order = state.orders.find(o => o.id === id) ||
                  state.orders.find(o => o._docId === id);
    if (!order) return '<div class="empty"><div class="empty-icon">❓</div><div>订单不存在</div></div>';

    const key = order._docId || order.id;
    const unpaid = getUnpaidAmount(order);
    const overdueLevel = getOverdueLevel(order);
    const overdueText = ['', '已超期（3-7天）', '已超期（7-10天）', '平台可能已自动收款'][overdueLevel] || '';

    let imagesHtml = '';
    if (order.images && order.images.length > 0) {
        if (order.images.length === 1) {
            imagesHtml = `<img src="${order.images[0]}" onclick="showImage('${escapeHtml(order.images[0])}')">`;
        } else {
            imagesHtml = `<div class="image-grid">${order.images.map(src =>
                `<img src="${src}" onclick="showImage('${escapeHtml(src)}')">`
            ).join('')}</div>`;
        }
    } else {
        imagesHtml = `<div class="empty" style="padding:40px 20px;"><div class="empty-icon">📐</div><div>暂无平面图</div></div>`;
    }

    const statusBtns = STATUS_LIST.map(s => `
        <button class="quick-btn ${order.status===s.key?'active':''}" onclick="changeStatus('${key}','${s.key}')">${s.label}</button>
    `).join('');

    const ph = (order.paymentHistory || []).slice().reverse();

    return `
        <div class="detail-title-bar">
            <button class="back-btn" onclick="navigate('orders')">
                <span class="arrow">←</span>
                <span>返回</span>
            </button>
            <div class="detail-title">${escapeHtml(order.customer)}</div>
            <span class="status-badge ${STATUS_MAP[order.status]?.class || ''}">${STATUS_MAP[order.status]?.label || order.status}</span>
        </div>

        <div style="display:flex;gap:16px;margin-bottom:20px;flex-wrap:wrap;">
            <div class="detail-image">${imagesHtml}</div>

            <div style="flex:1;min-width:280px;">
                <div class="payment-section">
                    <div style="font-size:13px;color:#6b7280;margin-bottom:4px;">待收款</div>
                    <div class="amount-big ${unpaid>0?'amount-owes':'amount-paid'}">
                        ${order.status==='cancel' ? '已取消' : formatMoney(unpaid)}
                    </div>
                    ${overdueText && unpaid>0 ? `<div style="font-size:12px;color:#f59e0b;margin-top:4px;">⚠️ ${overdueText}</div>` : ''}

                    ${order.status !== 'cancel' && unpaid > 0 ? `
                    <div style="display:flex;gap:6px;margin-top:10px;">
                        <input type="number" id="pay-input" min="0" step="0.01" value="${unpaid}" style="flex:1;padding:10px;border:1px solid #e5e7eb;border-radius:8px;font-size:14px;font-weight:600;">
                        <button class="btn btn-success" onclick="quickPay('${key}')">收款</button>
                    </div>
                    <div style="font-size:12px;color:#6b7280;margin-top:6px;">报价 ${formatMoney(order.price)} · 已收 ${formatMoney(order.paidAmount)}</div>
                    ` : `
                        <div style="font-size:13px;color:#6b7280;margin-top:8px;">报价 ${formatMoney(order.price)} · 已收 ${formatMoney(order.paidAmount)}</div>
                    `}
                </div>

                <div style="padding:10px 0;border-bottom:1px solid #e5e7eb;font-size:13px;">
                    <span style="color:#6b7280;">状态：</span>
                    <span class="status-badge ${STATUS_MAP[order.status]?.class || ''}">${STATUS_MAP[order.status]?.label || order.status}</span>
                </div>
                <div style="display:flex;flex-wrap:wrap;gap:6px;margin:8px 0;">${statusBtns}</div>

                <div style="padding:8px 0;border-bottom:1px solid #e5e7eb;font-size:13px;display:flex;justify-content:space-between;"><span style="color:#6b7280;">客户</span><span>${escapeHtml(order.customer)}</span></div>
                <div style="padding:8px 0;border-bottom:1px solid #e5e7eb;font-size:13px;display:flex;justify-content:space-between;"><span style="color:#6b7280;">店铺</span><span>${escapeHtml(order.shop || '（未指定）')}</span></div>
                <div style="padding:8px 0;border-bottom:1px solid #e5e7eb;font-size:13px;display:flex;justify-content:space-between;"><span style="color:#6b7280;">报价</span><span>${formatMoney(order.price)}</span></div>
                <div style="padding:8px 0;border-bottom:1px solid #e5e7eb;font-size:13px;display:flex;justify-content:space-between;"><span style="color:#6b7280;">已收</span><span>${formatMoney(order.paidAmount)}</span></div>
                ${order.count ? `<div style="padding:8px 0;border-bottom:1px solid #e5e7eb;font-size:13px;display:flex;justify-content:space-between;"><span style="color:#6b7280;">数量</span><span>${escapeHtml(order.count)}</span></div>`:''}
                ${order.modifyCount > 0 ? `<div style="padding:8px 0;border-bottom:1px solid #e5e7eb;font-size:13px;display:flex;justify-content:space-between;"><span style="color:#6b7280;">修改次数</span><span>第 ${order.modifyCount} 次</span></div>`:''}
                <div style="padding:8px 0;border-bottom:1px solid #e5e7eb;font-size:13px;display:flex;justify-content:space-between;"><span style="color:#6b7280;">创建</span><span>${formatDateTime(order.createdAt)}</span></div>
                <div style="padding:8px 0;border-bottom:1px solid #e5e7eb;font-size:13px;display:flex;justify-content:space-between;"><span style="color:#6b7280;">最后更新</span><span>${formatDateTime(order.updatedAt)}</span></div>
                ${order.note ? `<div style="padding:8px 0;border-bottom:1px solid #e5e7eb;font-size:13px;"><span style="color:#6b7280;">备注：</span><br><span style="white-space:pre-wrap;">${escapeHtml(order.note)}</span></div>`:''}

                ${order.status === 'done' ? `
                <div style="background:#ecfdf5;border:1px solid #d1fae5;border-radius:8px;padding:12px;margin:12px 0;">
                    <div style="font-size:13px;font-weight:600;color:#065f46;margin-bottom:8px;">📎 交付文件链接</div>
                    <div style="font-size:12px;color:#4b5563;margin-bottom:4px;">查看链接：</div>
                    <div style="display:flex;gap:6px;margin-bottom:8px;">
                        <input type="url" class="form-input" style="flex:1;margin:0;padding:8px 10px;font-size:13px;" id="link-view" value="${escapeHtml(order.viewLink || '')}">
                    </div>
                    <div style="font-size:12px;color:#4b5563;margin-bottom:4px;">源文件链接：</div>
                    <div style="display:flex;gap:6px;margin-bottom:10px;">
                        <input type="url" class="form-input" style="flex:1;margin:0;padding:8px 10px;font-size:13px;" id="link-source" value="${escapeHtml(order.sourceLink || '')}">
                    </div>
                    <button class="btn btn-primary" style="width:100%;padding:8px;font-size:13px;" onclick="saveLinks('${key}')">保存链接</button>
                </div>
                ` : ''}

                ${ph.length > 0 ? `
                <div style="margin-top:12px;padding-top:12px;border-top:1px solid #e5e7eb;">
                    <div style="font-size:13px;color:#6b7280;margin-bottom:6px;">收款记录</div>
                    ${ph.map(p => `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:13px;color:#374151;"><span>${formatDateTime(p.at)}</span><span style="color:#10b981;font-weight:600;">+${formatMoney(p.amount)}</span></div>`).join('')}
                </div>
                ` : ''}

                <div style="display:flex;gap:8px;margin-top:14px;">
                    <button class="btn btn-secondary" style="flex:1;" onclick="showEditModal('${key}')">✏️ 编辑</button>
                    <button class="btn btn-secondary" style="flex:1;" onclick="showAddImageModal('${key}')">📷 添加图片</button>
                    <button class="btn btn-danger" onclick="deleteOrder('${key}')">🗑️ 删除</button>
                </div>
            </div>
        </div>
    `;
}

function quickPay(id) {
    const input = document.getElementById('pay-input');
    if (!input) return;
    const amt = parseFloat(input.value);
    if (isNaN(amt) || amt <= 0) { showToast('请输入金额'); return; }
    if (recordPayment(id, amt)) {
        showToast('✓ 已收款，订单已完成');
        state.currentFilter = 'done';
        navigate('orders');
    }
}

function saveLinks(id) {
    const v = document.getElementById('link-view');
    const s = document.getElementById('link-source');
    if (!v || !s) return;
    const o = state.orders.find(x => x.id === id) || state.orders.find(x => x._docId === id);
    if (!o) return;
    o.viewLink = v.value.trim();
    o.sourceLink = s.value.trim();
    persistOrder(o);
    showToast('✓ 链接已保存');
    if (storageMode === 'local') renderCurrentPage();
}

function showImage(src) {
    const modal = document.getElementById('modal');
    const body = document.getElementById('modal-body');
    const img = document.createElement('img');
    img.src = src;
    img.style.cssText = 'width:100%;height:auto;max-height:80vh;object-fit:contain;border-radius:8px;display:block;';
    body.innerHTML = '';
    body.appendChild(img);
    modal.classList.add('show');
}

function closeModal(event) {
    if (event && event.target && event.target.closest && event.target.closest('.modal-content') && event.target !== event.currentTarget) return;
    document.getElementById('modal').classList.remove('show');
}

// 编辑弹窗
function showEditModal(id) {
    const o = state.orders.find(x => x.id === id) || state.orders.find(x => x._docId === id);
    if (!o) return;
    const shopOptions = state.shops.map(s =>
        `<option value="${escapeHtml(s)}" ${o.shop === s ? 'selected' : ''}>${escapeHtml(s)}</option>`
    ).join('');
    document.getElementById('modal-body').innerHTML = `
        <div style="font-size:16px;font-weight:600;margin-bottom:14px;">编辑订单</div>
        <div class="form-group"><label class="form-label">客户昵称</label><input class="form-input" id="edit-customer" value="${escapeHtml(o.customer)}"></div>
        <div class="form-group">
            <label class="form-label">来源店铺</label>
            <select class="form-input" id="edit-shop" style="width:100%;">
                <option value="">（未指定）</option>
                ${shopOptions}
            </select>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
            <div class="form-group"><label class="form-label">报价金额</label><input class="form-input" id="edit-price" type="number" min="0" step="0.01" value="${o.price || 0}"></div>
            <div class="form-group"><label class="form-label">已收金额</label><input class="form-input" id="edit-paid" type="number" min="0" step="0.01" value="${o.paidAmount || 0}"></div>
        </div>
        <div class="form-group"><label class="form-label">效果图数量</label><input class="form-input" id="edit-count" value="${escapeHtml(o.count || '')}" placeholder="1张"></div>
        <div class="form-group"><label class="form-label">查看链接</label><input class="form-input" id="edit-viewlink" value="${escapeHtml(o.viewLink || '')}" placeholder="https://..."></div>
        <div class="form-group"><label class="form-label">源文件链接</label><input class="form-input" id="edit-sourcelink" value="${escapeHtml(o.sourceLink || '')}" placeholder="https://..."></div>
        <div class="form-group"><label class="form-label">备注</label><textarea class="form-textarea" id="edit-note">${escapeHtml(o.note || '')}</textarea></div>
        <div style="display:flex;gap:8px;margin-top:12px;">
            <button class="btn btn-primary" style="flex:1;padding:12px;" onclick="saveEdit('${id}')">保存</button>
        </div>
    `;
    document.getElementById('modal').classList.add('show');
}

function saveEdit(id) {
    const o = state.orders.find(x => x.id === id) || state.orders.find(x => x._docId === id);
    if (!o) return;
    o.customer = document.getElementById('edit-customer').value.trim() || o.customer;
    o.shop = document.getElementById('edit-shop').value.trim();
    o.price = parseFloat(document.getElementById('edit-price').value) || 0;
    o.paidAmount = parseFloat(document.getElementById('edit-paid').value) || 0;
    o.count = document.getElementById('edit-count').value.trim();
    o.viewLink = document.getElementById('edit-viewlink').value.trim();
    o.sourceLink = document.getElementById('edit-sourcelink').value.trim();
    o.note = document.getElementById('edit-note').value.trim();
    // 金额变化后自动判断状态
    if (o.paidAmount >= o.price && o.paidAmount > 0 && o.status !== 'cancel') {
        o.status = 'done';
        if (!o.doneAt) o.doneAt = Date.now();
    } else if (o.paidAmount < o.price && o.status === 'done') {
        o.status = 'pending';
        o.doneAt = null;
    }
    persistOrder(o);
    closeModal();
    showToast('✓ 已保存');
    if (storageMode === 'local') renderCurrentPage();
}

// 添加图片弹窗
function showAddImageModal(id) {
    window._pendingImages = [];
    document.getElementById('modal-body').innerHTML = `
        <div style="font-size:16px;font-weight:600;margin-bottom:14px;">添加平面图</div>
        <div class="upload-area" onclick="document.getElementById('modal-image-input').click()">
            <div class="upload-icon">📐</div>
            <div class="upload-text">点击上传（支持多张）</div>
        </div>
        <input type="file" id="modal-image-input" accept="image/*" multiple style="display:none"
            onchange="handleModalImageUpload(event)">
        <div class="upload-preview" id="modal-upload-preview" style="margin-top:10px;"></div>
        <div style="display:flex;gap:8px;margin-top:12px;">
            <button class="btn btn-primary" style="flex:1;padding:12px;" onclick="saveAddImages('${id}')">添加</button>
        </div>
    `;
    document.getElementById('modal').classList.add('show');
}

function handleModalImageUpload(event) {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;
    let loaded = 0;
    files.forEach(file => {
        compressImage(file, 1200, 0.82).then(dataUrl => {
            window._pendingImages.push(dataUrl);
            loaded++;
            const preview = document.getElementById('modal-upload-preview');
            if (preview) preview.innerHTML = window._pendingImages.map((src, i) => `
                <div class="upload-preview-item">
                    <img src="${src}">
                    <div class="remove-btn" onclick="removeModalImage(${i})">✕</div>
                </div>
            `).join('');
            if (loaded === files.length) showToast(`已选 ${files.length} 张`);
        });
    });
    event.target.value = '';
}

function removeModalImage(idx) {
    window._pendingImages.splice(idx, 1);
    const preview = document.getElementById('modal-upload-preview');
    if (preview) preview.innerHTML = window._pendingImages.map((src, i) => `
        <div class="upload-preview-item">
            <img src="${src}">
            <div class="remove-btn" onclick="removeModalImage(${i})">✕</div>
        </div>
    `).join('');
}

function saveAddImages(id) {
    if (window._pendingImages.length === 0) { showToast('请先选择图片'); return; }
    const o = state.orders.find(x => x.id === id) || state.orders.find(x => x._docId === id);
    if (!o) return;
    o.images = (o.images || []).concat(window._pendingImages);
    o.updatedAt = Date.now();
    window._pendingImages = [];
    persistOrder(o);
    closeModal();
    showToast('✓ 已添加');
    if (storageMode === 'local') renderCurrentPage();
}

// ========== 统计 ==========
function renderStats() {
    const now = new Date();
    const curY = now.getFullYear();
    const curM = now.getMonth();

    const orders = state.orders;
    const thisMonth = orders.filter(o => {
        const d = tsToDate(o.createdAt);
        return d.getFullYear() === curY && d.getMonth() === curM;
    });
    const monthDone = thisMonth.filter(o => o.status === 'done').length;
    const monthPaid = thisMonth.reduce((s, o) => s + (Number(o.paidAmount) || 0), 0);
    const monthUnpaid = thisMonth.filter(isUnpaid).reduce((s, o) => s + getUnpaidAmount(o), 0);

    const monthStats = [];
    for (let i = 5; i >= 0; i--) {
        const d = new Date(curY, curM - i, 1);
        const list = orders.filter(o => {
            const dd = tsToDate(o.createdAt);
            return dd.getFullYear() === d.getFullYear() && dd.getMonth() === d.getMonth();
        });
        const done = list.filter(o => o.status === 'done').length;
        const paid = list.reduce((s, o) => s + (Number(o.paidAmount) || 0), 0);
        monthStats.push({ label: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`, count: list.length, done, paid });
    }

    // 柱状图归一化（关键：使用固定高度 180px，数据=0 时也显示 4px 小柱子占位）
    const maxCount = Math.max(1, ...monthStats.map(m => m.count));
    const maxPaid = Math.max(1, ...monthStats.map(m => m.paid));
    const chartMaxHeight = 180;

    const totalOrders = orders.length;
    const totalRevenue = orders.reduce((s, o) => s + (Number(o.paidAmount) || 0), 0);
    const totalPrice = orders.reduce((s, o) => s + (Number(o.price) || 0), 0);
    const totalUnpaid = orders.filter(isUnpaid).reduce((s, o) => s + getUnpaidAmount(o), 0);

    // ========== 按店铺统计 ==========
    const shopStatsMap = {};
    const shopCount = {};
    for (const o of orders) {
        const shopName = o.shop || '未指定';
        if (!shopStatsMap[shopName]) {
            shopStatsMap[shopName] = { count: 0, done: 0, paid: 0, price: 0, unpaid: 0 };
            shopCount[shopName] = 0;
        }
        shopStatsMap[shopName].count++;
        shopStatsMap[shopName].price += Number(o.price) || 0;
        shopStatsMap[shopName].paid += Number(o.paidAmount) || 0;
        if (o.status === 'done') shopStatsMap[shopName].done++;
        const u = getUnpaidAmount(o);
        if (u > 0) shopStatsMap[shopName].unpaid += u;
    }
    const shopStatsList = Object.entries(shopStatsMap)
        .map(([name, s]) => ({ name, ...s }))
        .sort((a, b) => b.count - a.count || b.paid - a.paid);

    const maxShopCount = Math.max(1, ...shopStatsList.map(s => s.count));
    const maxShopPaid = Math.max(1, ...shopStatsList.map(s => s.paid));

    const shopBarsHtml = shopStatsList.map(s => {
        const countH = s.count === 0 ? 4 : Math.max(8, Math.round(s.count / maxShopCount * chartMaxHeight));
        const paidH = s.paid === 0 ? 4 : Math.max(8, Math.round(s.paid / maxShopPaid * chartMaxHeight));
        const countLabel = s.count > 0 ? String(s.count) : '';
        const paidLabel = s.paid > 0 ? formatMoney(s.paid).replace('¥', '') : '';
        return `
            <div class="bar-col">
                <div class="bar-bars">
                    <div class="bar-item bar-blue" style="height:${countH}px;">
                        <span class="bar-tooltip">${countLabel}</span>
                    </div>
                    <div class="bar-item bar-green" style="height:${paidH}px;">
                        <span class="bar-tooltip">${paidLabel}</span>
                    </div>
                </div>
                <div class="bar-label">${escapeHtml(s.name)}</div>
            </div>
        `;
    }).join('');

    // 构建 6 个月份 × 双柱子 的 HTML
    const barsHtml = monthStats.map(ms => {
        // 接单柱（蓝色）：0 -> 4px，其他按比例
        const countH = ms.count === 0 ? 4 : Math.max(8, Math.round(ms.count / maxCount * chartMaxHeight));
        // 收款柱（绿色）
        const paidH = ms.paid === 0 ? 4 : Math.max(8, Math.round(ms.paid / maxPaid * chartMaxHeight));
        const monthNum = parseInt(ms.label.split('-')[1], 10);
        const countLabel = ms.count > 0 ? String(ms.count) : '';
        const paidLabel = ms.paid > 0 ? formatMoney(ms.paid).replace('¥', '') : '';
        return `
            <div class="bar-col">
                <div class="bar-bars">
                    <div class="bar-item bar-blue" style="height:${countH}px;">
                        <span class="bar-tooltip">${countLabel}</span>
                    </div>
                    <div class="bar-item bar-green" style="height:${paidH}px;">
                        <span class="bar-tooltip">${paidLabel}</span>
                    </div>
                </div>
                <div class="bar-label">${monthNum}月</div>
            </div>
        `;
    }).join('');

    return `
        <div class="page-title">📈 数据统计</div>

        <div class="stats-grid">
            <div class="stat-card"><div class="stat-label">本月接单</div><div class="stat-value">${thisMonth.length}</div></div>
            <div class="stat-card"><div class="stat-label">本月完成</div><div class="stat-value">${monthDone}</div></div>
            <div class="stat-card"><div class="stat-label">已收款</div><div class="stat-value" style="color:var(--success);">${formatMoney(monthPaid)}</div></div>
            <div class="stat-card"><div class="stat-label">待收款</div><div class="stat-value" style="color:var(--warning);">${formatMoney(monthUnpaid)}</div></div>
        </div>

        <div class="section">
            <div class="section-title-row">
                <div class="section-title">近 6 个月</div>
                <div class="bar-legend">
                    <div class="bar-legend-item"><span class="bar-legend-dot"></span>接单数</div>
                    <div class="bar-legend-item"><span class="bar-legend-dot dot-green"></span>收款额</div>
                </div>
            </div>

            <div class="bar-chart">
                <div class="bar-chart-grid">
                    ${barsHtml}
                </div>
            </div>

            <div style="margin-top:8px;font-size:12px;color:var(--text-tertiary);text-align:center;">
                柱高按当月占 6 个月最高值的比例显示 · 悬停在柱子上可查看具体数值
            </div>
        </div>

        <div class="section">
            <div class="section-title-row">
                <div class="section-title">累计统计</div>
            </div>
            <div class="stats-grid stats-grid-compact">
                <div class="stat-card stat-card-small"><div class="stat-label">订单总数</div><div class="stat-value">${totalOrders}</div></div>
                <div class="stat-card stat-card-small"><div class="stat-label">总报价</div><div class="stat-value" style="font-size:22px;">${formatMoney(totalPrice)}</div></div>
                <div class="stat-card stat-card-small"><div class="stat-label">总收入</div><div class="stat-value" style="font-size:22px;color:var(--success);">${formatMoney(totalRevenue)}</div></div>
                <div class="stat-card stat-card-small"><div class="stat-label">总待收</div><div class="stat-value" style="font-size:22px;color:var(--warning);">${formatMoney(totalUnpaid)}</div></div>
            </div>
        </div>

        ${shopStatsList.length > 0 ? `
        <div class="section">
            <div class="section-title-row">
                <div class="section-title">按店铺</div>
                <div class="bar-legend">
                    <div class="bar-legend-item"><span class="bar-legend-dot"></span>订单数</div>
                    <div class="bar-legend-item"><span class="bar-legend-dot dot-green"></span>收款额</div>
                </div>
            </div>

            <div class="bar-chart">
                <div class="bar-chart-grid">
                    ${shopBarsHtml}
                </div>
            </div>

            <div style="margin-top:16px;">
                ${shopStatsList.map((s, i) => `
                    <div class="shop-stat-row" style="${i > 0 ? 'border-top:1px solid var(--separator);' : ''}">
                        <div class="shop-stat-rank">${i + 1}</div>
                        <div class="shop-stat-info">
                            <div class="shop-stat-name">${escapeHtml(s.name)}</div>
                            <div class="shop-stat-detail">
                                订单 <b>${s.count}</b> · 完成 <b style="color:var(--success);">${s.done}</b> · 待收 <b style="color:var(--warning);">${formatMoney(s.unpaid)}</b>
                            </div>
                        </div>
                        <div class="shop-stat-amount">
                            <div style="font-size:11px;color:var(--text-tertiary);">收入</div>
                            <div style="font-size:18px;font-weight:700;color:var(--success);">${formatMoney(s.paid)}</div>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
        ` : ''}
    `;
}

// ========== 导出 / 导入 ==========
function exportData() {
    const json = JSON.stringify({ orders: state.orders, exportedAt: Date.now(), storageMode }, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `订单数据_${formatDate(Date.now())}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('已导出');
}

function importData(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
        try {
            const parsed = JSON.parse(e.target.result);
            // 兼容多种 JSON 顶层结构：可能是数组，也可能是 {orders: [...]}
            const list = Array.isArray(parsed) ? parsed : (parsed.orders || parsed.data || []);
            if (!Array.isArray(list) || list.length === 0) { showToast('未在文件里发现订单数据'); return; }
            const mapped = list.map(normalizeOrder).filter(Boolean);
            doImportOrders(mapped, '文件导入');
        } catch (err) {
            showToast('解析失败：' + err.message);
        }
    };
    reader.readAsText(file);
    event.target.value = '';
}

// 把各种字段名的"旧订单"转换为新系统字段
function normalizeOrder(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const price = Number(raw.price || raw.amount || raw.money || 0) || 0;
    const paid = Number(
        raw.paidAmount || raw.paid_amount ||
        (typeof raw.paid === 'number' && raw.paid ? (raw.paid > 1 ? raw.paid : price) : 0) ||
        0
    ) || 0;
    const customer = raw.customer || raw.agent || raw.client || raw.name || '（未填客户）';
    // 状态：旧系统可能用 boolean(paid) 或字符串
    let status = raw.status || 'pending';
    if (typeof raw.paid === 'boolean') {
        if (raw.paid) status = 'done';
    }
    if (typeof raw.received === 'boolean' && raw.received) status = 'done';
    const note = [
        raw.note || '',
        raw.remark || '',
        raw.entryDate ? `录入日期：${raw.entryDate}` : '',
        raw.receiveDate ? `交付日期：${raw.receiveDate}` : '',
        raw.paidDate ? `收款日期：${raw.paidDate}` : '',
    ].filter(Boolean).join(' | ');
    const cAt = tsToNumber(raw.createdAt || raw.created_at || raw.entryDate || Date.now()) || Date.now();
    const uAt = tsToNumber(raw.updatedAt || raw.updated_at || raw.lastUpdate || cAt) || cAt;
    const dAt = raw.deliveredAt || raw.receiveDate ? tsToNumber(raw.deliveredAt || raw.receiveDate) : null;
    const doneAt = (status === 'done' && (raw.doneAt || raw.paidDate || raw.updatedAt))
        ? tsToNumber(raw.doneAt || raw.paidDate || raw.updatedAt)
        : null;
    return {
        id: raw.id || uid(),
        customer: String(customer).slice(0, 80),
        price,
        paidAmount: paid,
        status,
        note: note.slice(0, 500),
        images: raw.images || [],
        count: raw.count || '',
        modifyCount: Number(raw.modifyCount) || 0,
        viewLink: raw.viewLink || '',
        sourceLink: raw.sourceLink || '',
        paymentHistory: raw.paymentHistory || [],
        createdAt: cAt,
        updatedAt: uAt,
        deliveredAt: dAt,
        doneAt,
    };
}

function doImportOrders(list, label) {
    if (!list || list.length === 0) { showToast('没有可导入的订单'); return; }
    if (storageMode === 'cloud') {
        if (!confirm(`将导入 ${list.length} 个订单到云端（合并）。是否继续？`)) return;
        list.forEach(cloudWrite);
        showToast(`✅ 已导入 ${list.length} 个订单（${label}）`);
    } else {
        const existingIds = new Set(state.orders.map(o => o.id));
        const merged = list.filter(o => !existingIds.has(o.id));
        state.orders = state.orders.concat(merged);
        saveToLocalStorage();
        showToast(`✅ 已导入 ${merged.length} 个订单（${label}）`);
        renderCurrentPage();
    }
}

// 启动时自动扫描：如果当前系统是空的，就去读 LocalStorage 里常见的旧 key
function tryAutoMigrateOldLocalData() {
    if (storageMode !== 'local') return;
    if (state.orders.length > 0) return; // 已经有数据了就不覆盖
    // 常用旧 key 列表 — 按优先级尝试
    const candidateKeys = [
        'order_management_data_v1',
        'orders',
        'order-data',
        'orders-data',
        'zhihu/order',
        'orderManagement',
        'app_orders',
    ];
    for (const k of candidateKeys) {
        try {
            const raw = localStorage.getItem(k);
            if (!raw) continue;
            const parsed = JSON.parse(raw);
            const list = Array.isArray(parsed) ? parsed
                : (parsed.orders || parsed.data || (parsed.orders && parsed.orders.list) || []);
            if (Array.isArray(list) && list.length > 0) {
                const mapped = list.map(normalizeOrder).filter(Boolean);
                if (mapped.length > 0) {
                    state.orders = mapped;
                    saveToLocalStorage();
                    showToast(`检测到 ${mapped.length} 条本地历史订单，已自动迁移`);
                    return;
                }
            }
        } catch (e) { /* 某个 key 解析失败就跳过 */ }
    }
}

// 页面加载完成后尝试一次自动迁移（仅针对本地模式）
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(tryAutoMigrateOldLocalData, 600);
});

// 暴露到全局（手动触发按钮用）
window.importData = importData;
window.tryAutoMigrateOldLocalData = tryAutoMigrateOldLocalData;

// ========== 拖拽上传 ==========
document.addEventListener('dragover', e => {
    if (state.currentPage === 'new') { e.preventDefault(); const a = document.getElementById('upload-area'); if (a) a.classList.add('dragging'); }
});
document.addEventListener('dragleave', () => {
    const a = document.getElementById('upload-area');
    if (a) a.classList.remove('dragging');
});
document.addEventListener('drop', e => {
    if (state.currentPage === 'new') {
        e.preventDefault();
        const a = document.getElementById('upload-area');
        if (a) a.classList.remove('dragging');
        const files = e.dataTransfer.files;
        if (files && files.length > 0) {
            Array.from(files).forEach(file => {
                if (!file.type.startsWith('image/')) return;
                compressImage(file, 1200, 0.82).then(dataUrl => {
                    window._pendingImages.push(dataUrl);
                    renderUploadPreview();
                });
            });
        }
    }
});

// 暴露到全局，供 HTML onclick 调用
window.signIn = signIn;
window.signUp = signUp;
window.signOut = signOut;
window.signInAnon = signInAnon;
window.tryCloudLogin = tryCloudLogin;
window.navigate = navigate;
window.exportData = exportData;
window.importData = importData;
window.closeModal = closeModal;
window.handleImageUpload = handleImageUpload;
window.renderUploadPreview = renderUploadPreview;
window.removePendingImage = removePendingImage;
window.handleNewOrderSubmit = handleNewOrderSubmit;
window.changeStatus = changeStatus;
window.quickPay = quickPay;
window.saveLinks = saveLinks;
window.showImage = showImage;
window.showEditModal = showEditModal;
window.saveEdit = saveEdit;
window.showAddImageModal = showAddImageModal;
window.handleModalImageUpload = handleModalImageUpload;
window.removeModalImage = removeModalImage;
window.saveAddImages = saveAddImages;
window.deleteOrder = deleteOrder;
window.selectShop = selectShop;
window.showAddShopModal = showAddShopModal;
window.addShop = addShop;
window.removeShop = removeShop;

// ========== Telegram 通知设置页 ==========
function renderSettings() {
    // 读取当前用户的 Telegram 设置（云端模式读 Firestore；本地模式读 LocalStorage）
    const pending = `<div style="color:#6b7280;font-size:13px;">加载中...</div>`;
    const html = `
        <div class="page-title">🔔 通知设置</div>

        <div class="section">
            <div class="section-title">Telegram 机器人提醒</div>

            <div style="background:#fff8f0;border:1px solid #ffe0cc;border-radius:8px;padding:12px;margin-bottom:16px;font-size:13px;line-height:1.6;color:#5b3b1e;">
                <b>使用步骤：</b><br>
                1. 在 Telegram 搜索 <b>@BotFather</b>，发送 <code>/newbot</code> 创建你的机器人<br>
                2. 创建后会得到一个 <b>Bot Token</b>（形如 <code>1234567890:ABCdefGHI...</code>）<br>
                3. 在 Telegram 里点一下你创建的机器人，发一条消息 <code>/start</code>（先"激活"聊天）<br>
                4. 再在浏览器里打开：<code>https://api.telegram.org/bot<span style="color:#d97706;">你的Token</span>/getUpdates</code><br>
                5. 在返回的 JSON 里找到 <code>chat.id</code>（一串数字），就是你的 <b>Chat ID</b><br>
                6. 把 Token 和 Chat ID 填到下面的框里，保存即可<br>
                <b>Bot Token</b> 需要部署到 Cloud Functions 时设置（我会给你命令）。
            </div>

            <div style="display:grid;gap:12px;">
                <div class="form-group">
                    <label class="form-label">你的 Telegram Chat ID（一串数字）</label>
                    <input class="form-input" id="tg-chat-id" placeholder="例如 1234567890" value="">
                    <div style="font-size:12px;color:#6b7280;margin-top:4px;">Cloud Functions 会把提醒发到这个 ID</div>
                </div>

                <div class="form-group">
                    <label class="form-label">
                        <input type="checkbox" id="tg-enabled" checked style="margin-right:6px;vertical-align:middle;">
                        启用 Telegram 定时提醒
                    </label>
                    <div style="font-size:12px;color:#6b7280;margin-top:4px;">默认每天 10:00（北京时间）扫描一次，命中规则才发消息</div>
                </div>

                <div style="display:flex;gap:8px;">
                    <button class="btn btn-primary" style="flex:1;padding:12px;" onclick="saveTelegramSettings()">💾 保存设置</button>
                    <button class="btn btn-secondary" style="padding:12px 16px;" onclick="testTelegram()">🔔 发一条测试</button>
                </div>
            </div>

            <div id="tg-status" style="margin-top:14px;font-size:13px;color:#10b981;"></div>
        </div>

        <div class="section">
            <div class="section-title">当前启用的提醒规则</div>
            <div style="font-size:13px;line-height:2;color:#5b3b1e;">
                ✅ <b>待制作超 2 天</b>：订单创建后仍未改为"制作中"<br>
                ✅ <b>制作中停滞 3 天</b>：更新时间超 3 天未推进<br>
                ✅ <b>交付后 3 天未收款</b>：已交付 + 还有待收金额<br>
                ✅ <b>交付后 7 天未收款</b>：严重提醒<br>
                <span style="color:#9ca3af;">📌 每条订单 + 每类规则只会提醒一次，避免骚扰</span>
            </div>
        </div>

        <div class="section">
            <div class="section-title">店铺管理</div>
            <div style="font-size:13px;color:#6b7280;margin-bottom:12px;">管理订单来源店铺，新增订单时可选择来源</div>
            <div id="shops-list" style="display:flex;flex-wrap:gap:8px;flex-wrap:wrap;">
                ${state.shops.map((s, i) => `
                    <div style="display:flex;align-items:center;gap:6px;padding:6px 10px;background:var(--bg-secondary);border-radius:8px;margin-right:8px;margin-bottom:8px;">
                        <span>${escapeHtml(s)}</span>
                        <button class="mini-btn" onclick="removeShop(${i})" title="删除店铺">✕</button>
                    </div>
                `).join('')}
            </div>
            <button class="btn btn-secondary" style="margin-top:12px;padding:8px 16px;font-size:13px;" onclick="showAddShopModal()">+ 添加新店铺</button>
        </div>

        <div class="section">
            <div class="section-title">数据位置</div>
            <div style="font-size:13px;line-height:1.8;color:#4b5563;">
                ${storageMode === 'cloud'
                    ? '☁️ 当前为云端同步模式（Firestore），设置保存在 <code>users/' + (currentUserId || '[uid]') + '/profile</code>'
                    : '💻 当前为本机模式（LocalStorage），设置不跨设备同步'}
            </div>
        </div>

        ${storageMode === 'cloud' ? pending : ''}
    `;
    // 异步加载现有设置
    setTimeout(loadTelegramSettings, 50);
    return html;
}

function loadTelegramSettings() {
    const idEl = document.getElementById('tg-chat-id');
    const enEl = document.getElementById('tg-enabled');
    if (!idEl || !enEl) return;

    if (storageMode === 'cloud' && currentUserId) {
        fbFirestore.collection('users').doc(currentUserId).get()
            .then(doc => {
                const p = doc.exists ? doc.data() : {};
                if (p.telegramChatId) idEl.value = p.telegramChatId;
                enEl.checked = p.telegramEnabled !== false;
                const st = document.getElementById('tg-status');
                if (st) st.textContent = p.telegramChatId ? '✅ 已绑定 Chat ID' : '';
            })
            .catch(err => {
                const st = document.getElementById('tg-status');
                if (st) { st.style.color = '#ef4444'; st.textContent = '读取失败: ' + err.message; }
            });
    } else {
        try {
            const raw = localStorage.getItem('order_management_telegram');
            if (raw) {
                const s = JSON.parse(raw);
                if (s.chatId) idEl.value = s.chatId;
                enEl.checked = s.enabled !== false;
            }
        } catch (e) {}
    }
}

function saveTelegramSettings() {
    const idEl = document.getElementById('tg-chat-id');
    const enEl = document.getElementById('tg-enabled');
    if (!idEl || !enEl) return;

    const chatId = idEl.value.trim();
    const enabled = enEl.checked;
    const st = document.getElementById('tg-status');

    if (!chatId) {
        if (st) { st.style.color = '#ef4444'; st.textContent = '请先填写 Chat ID'; }
        return;
    }

    if (storageMode === 'cloud' && currentUserId) {
        fbFirestore.collection('users').doc(currentUserId).set(
            { telegramChatId: chatId, telegramEnabled: enabled },
            { merge: true }
        ).then(() => {
            if (st) { st.style.color = '#10b981'; st.textContent = '✅ 设置已保存（云端同步）'; }
            showToast('已保存');
        }).catch(err => {
            if (st) { st.style.color = '#ef4444'; st.textContent = '保存失败：' + err.message; }
        });
    } else {
        try {
            localStorage.setItem('order_management_telegram', JSON.stringify({ chatId, enabled }));
            if (st) { st.style.color = '#10b981'; st.textContent = '✅ 设置已保存（本机）'; }
            showToast('已保存');
        } catch (e) {
            if (st) { st.style.color = '#ef4444'; st.textContent = '保存失败：' + e.message; }
        }
    }
}

// 测试消息：前端调用时，先用一个简单的"测试文本"发给当前 chatId
// ——注意：前端调用 Bot API 存在浏览器 CORS/暴露 Token 的问题，
//  因此"生产环境"的测试消息由 Cloud Functions 提供 URL（更安全）。
//  这里仅展示一条提示，避免让用户把 token 塞进前端源码。
function testTelegram() {
    showToast('测试消息由 Cloud Functions 提供（见部署说明）。部署好后访问 Cloud Functions 的 testNotify URL 即可立即触发一次扫描。');
}

// 把新函数暴露到全局
window.renderSettings = renderSettings;
window.saveTelegramSettings = saveTelegramSettings;
window.testTelegram = testTelegram;
window.loadTelegramSettings = loadTelegramSettings;
