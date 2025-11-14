// 全局变量声明
window.PIXI = window.PIXI || {};

// 全局变量
let current3DModel = null;
let emotionMapping3D = null;
let currentEmotion3D = 'neutral';
let pixi_app_3d = null;
let is3DInitialized = false;

let motionTimer3D = null; // 动作持续时间定时器 (3D模式专用)
let isEmotionChanging3D = false; // 防止快速连续点击的标志 (3D模式专用)

// ===== 新增：3D MMD 支持变量 =====
let is3DMode = false; // 是否使用3D模式
let currentRenderer = null;
let currentScene = null;
let currentCamera = null;
let mmdHelper = null;
let mouthController = null;
let dragController = null;

// VRM到Three.js的适配器
class VRMAdapter {
    constructor() {
        this.vrm = null;
        this.mesh = null;
        this.mixer = null;
        this.animations = [];
    }

    async loadVRM(vrmUrl) {
        try {
            // 使用标准的 Three.js GLTFLoader 加载 VRM
            const loader = new THREE.GLTFLoader();
            
            return new Promise((resolve, reject) => {
                loader.load(vrmUrl, (gltf) => {
                    this.mesh = gltf.scene;
                    this.animations = gltf.animations || [];
                    
                    // 启用阴影
                    this.mesh.traverse((child) => {
                        if (child.isMesh) {
                            child.castShadow = true;
                            child.receiveShadow = true;
                        }
                    });

                    // 查找骨骼用于口型同步
                    this.findMouthBones();
                    
                    resolve(this);
                }, undefined, reject);
            });
        } catch (error) {
            console.error('VRM加载失败:', error);
            throw error;
        }
    }

    findMouthBones() {
        // 查找口型相关的骨骼
        this.mouthBones = {};
        this.mesh.traverse((child) => {
            if (child.isBone) {
                const boneName = child.name.toLowerCase();
                if (boneName.includes('jaw') || boneName.includes('mouth') || boneName.includes('lip')) {
                    this.mouthBones[boneName] = child;
                }
            }
        });
    }

    setMouthOpen(openAmount) {
        // 根据开口度设置口型
        if (!this.mouthBones) return;

        // 简单的口型控制 - 通过旋转下巴骨骼
        Object.values(this.mouthBones).forEach(bone => {
            if (bone.name.toLowerCase().includes('jaw')) {
                bone.rotation.x = openAmount * 0.3; // 适度的旋转
            }
        });
    }
}

// 口型同步控制器
class MouthController {
    constructor(modelAdapter) {
        this.modelAdapter = modelAdapter;
        this.audioContext = null;
        this.analyser = null;
        this.dataArray = null;
        this.isRunning = false;
        this.smoothingFactor = 0.8;
        this.currentLevel = 0;
        
        // 不同频率的权重用于口型同步
        this.frequencyWeights = {
            low: 0.3,    // 低频 (0-500Hz)
            mid: 0.5,    // 中频 (500-2000Hz) 
            high: 0.2    // 高频 (2000Hz+)
        };
    }

    async initialize() {
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            return true;
        } catch (error) {
            console.error('音频上下文初始化失败:', error);
            return false;
        }
    }

    async startAudioAnalysis(stream) {
        if (!this.audioContext) {
            await this.initialize();
        }

        try {
            const source = this.audioContext.createMediaStreamSource(stream);
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 2048;
            this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
            
            source.connect(this.analyser);
            this.isRunning = true;
            
            this.analyzeAudio();
            return true;
        } catch (error) {
            console.error('音频分析启动失败:', error);
            return false;
        }
    }

    analyzeAudio() {
        if (!this.isRunning || !this.analyser) return;

        this.analyser.getByteFrequencyData(this.dataArray);
        
        // 计算不同频段的总能量
        const sampleRate = this.audioContext.sampleRate;
        const binSize = sampleRate / (2 * this.analyser.frequencyBinCount);
        
        let lowEnergy = 0, midEnergy = 0, highEnergy = 0;
        
        for (let i = 0; i < this.dataArray.length; i++) {
            const frequency = i * binSize;
            const amplitude = this.dataArray[i];
            
            if (frequency < 500) {
                lowEnergy += amplitude;
            } else if (frequency < 2000) {
                midEnergy += amplitude;
            } else {
                highEnergy += amplitude;
            }
        }
        
        // 标准化能量值
        const maxEnergy = 255 * this.dataArray.length;
        lowEnergy /= maxEnergy;
        midEnergy /= maxEnergy;
        highEnergy /= maxEnergy;
        
        // 计算加权口型值
        let targetLevel = (
            lowEnergy * this.frequencyWeights.low +
            midEnergy * this.frequencyWeights.mid +
            highEnergy * this.frequencyWeights.high
        );
        
        // 应用平滑
        this.currentLevel = this.currentLevel * this.smoothingFactor + 
                          targetLevel * (1 - this.smoothingFactor);
        
        // 应用到模型
        if (this.modelAdapter && this.modelAdapter.setMouthOpen) {
            this.modelAdapter.setMouthOpen(this.currentLevel);
        }
        
        requestAnimationFrame(() => this.analyzeAudio());
    }

    stop() {
        this.isRunning = false;
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
    }
}

// 拖动控制器
class DragController {
    constructor(renderer, camera, scene) {
        this.renderer = renderer;
        this.camera = camera;
        this.scene = scene;
        this.isDragging = false;
        this.previousMousePosition = { x: 0, y: 0 };
        this.targetRotation = { x: 0, y: 0 };
        this.currentRotation = { x: 0, y: 0 };
        this.rotationSpeed = 0.005;
        this.smoothing = 0.1;
        
        this.setupEventListeners();
    }

    setupEventListeners() {
        const canvas = this.renderer.domElement;
        
        canvas.addEventListener('mousedown', this.onMouseDown.bind(this));
        canvas.addEventListener('mousemove', this.onMouseMove.bind(this));
        canvas.addEventListener('mouseup', this.onMouseUp.bind(this));
        canvas.addEventListener('wheel', this.onWheel.bind(this));
        
        // 触摸事件支持
        canvas.addEventListener('touchstart', this.onTouchStart.bind(this));
        canvas.addEventListener('touchmove', this.onTouchMove.bind(this));
        canvas.addEventListener('touchend', this.onTouchEnd.bind(this));
    }

    onMouseDown(event) {
        this.isDragging = true;
        this.previousMousePosition = { x: event.clientX, y: event.clientY };
        event.preventDefault();
    }

    onMouseMove(event) {
        if (!this.isDragging) return;
        
        const deltaX = event.clientX - this.previousMousePosition.x;
        const deltaY = event.clientY - this.previousMousePosition.y;
        
        this.targetRotation.y += deltaX * this.rotationSpeed;
        this.targetRotation.x += deltaY * this.rotationSpeed;
        
        // 限制X轴旋转角度
        this.targetRotation.x = Math.max(-Math.PI/2, Math.min(Math.PI/2, this.targetRotation.x));
        
        this.previousMousePosition = { x: event.clientX, y: event.clientY };
    }

    onMouseUp() {
        this.isDragging = false;
    }

    onWheel(event) {
        event.preventDefault();
        const scale = event.deltaY > 0 ? 0.9 : 1.1;
        this.camera.position.multiplyScalar(scale);
    }

    onTouchStart(event) {
        if (event.touches.length === 1) {
            this.isDragging = true;
            this.previousMousePosition = { 
                x: event.touches[0].clientX, 
                y: event.touches[0].clientY 
            };
        }
    }

    onTouchMove(event) {
        if (!this.isDragging || event.touches.length !== 1) return;
        
        event.preventDefault();
        const deltaX = event.touches[0].clientX - this.previousMousePosition.x;
        const deltaY = event.touches[0].clientY - this.previousMousePosition.y;
        
        this.targetRotation.y += deltaX * this.rotationSpeed;
        this.targetRotation.x += deltaY * this.rotationSpeed;
        
        this.targetRotation.x = Math.max(-Math.PI/2, Math.min(Math.PI/2, this.targetRotation.x));
        
        this.previousMousePosition = { 
            x: event.touches[0].clientX, 
            y: event.touches[0].clientY 
        };
    }

    onTouchEnd() {
        this.isDragging = false;
    }

    update() {
        // 平滑插值
        this.currentRotation.x += (this.targetRotation.x - this.currentRotation.x) * this.smoothing;
        this.currentRotation.y += (this.targetRotation.y - this.currentRotation.y) * this.smoothing;
        
        // 应用旋转到相机
        if (this.camera.parent) {
            this.camera.parent.rotation.x = this.currentRotation.x;
            this.camera.parent.rotation.y = this.currentRotation.y;
        }
    }

    dispose() {
        const canvas = this.renderer.domElement;
        canvas.removeEventListener('mousedown', this.onMouseDown);
        canvas.removeEventListener('mousemove', this.onMouseMove);
        canvas.removeEventListener('mouseup', this.onMouseUp);
        canvas.removeEventListener('wheel', this.onWheel);
        canvas.removeEventListener('touchstart', this.onTouchStart);
        canvas.removeEventListener('touchmove', this.onTouchMove);
        canvas.removeEventListener('touchend', this.onTouchEnd);
    }
}

// Live2D 管理器类定义已移除，避免与 live2d.js 中的类重复
// 相关的孤立方法也已清理

// MMD 3D 管理器类
class MMD3DManager {
    constructor() {
        this.currentModel = null;
        this.modelAdapter = null;
        this.renderer = null;
        this.scene = null;
        this.camera = null;
        this.isInitialized = false;
        this.canvasId = null;
        this.containerId = null;
        
        // 默认模型路径（使用three-mmd示例中的miku模型）
        this.defaultModelPath = '/miku_v2.pmd';
        this.defaultAnimationPath = '/wavefile_v2.vmd';
        
        // 控制器
        this.mouthController = null;
        this.dragController = null;
        
        // 渲染循环
        this.renderLoop = null;
        this.isRunning = false;
        
        // 事件回调
        this.onModelLoaded = null;
        this.onStatusUpdate = null;
    }

    // 初始化 3D 场景
    async init3D(canvasId, containerId) {
        if (this.isInitialized) {
            console.warn('MMD3D 管理器已经初始化');
            return;
        }

        try {
            this.canvasId = canvasId;
            this.containerId = containerId;

            // 初始化three-mmd桥接
            console.log('正在初始化three-mmd桥接...');
            if (typeof window.initThreeMMD === 'function') {
                await window.initThreeMMD();
                console.log('three-mmd桥接初始化完成');
            } else {
                console.warn('three-mmd桥接函数未找到，将使用备用方案');
            }

            // 检查 Three.js 是否已加载
            if (typeof THREE === 'undefined') {
                throw new Error('Three.js 未加载。请在 HTML 中引入 three.min.js');
            }

            // 创建渲染器
            this.renderer = new THREE.WebGLRenderer({
                canvas: document.getElementById(canvasId),
                antialias: true,
                alpha: true
            });
            
            const container = document.getElementById(containerId);
            this.renderer.setSize(container.clientWidth, container.clientHeight);
            this.renderer.setPixelRatio(window.devicePixelRatio);
            this.renderer.shadowMap.enabled = true;
            this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
            this.renderer.outputEncoding = THREE.sRGBEncoding;

            // 创建场景
            this.scene = new THREE.Scene();
            this.scene.background = null;

            // 创建相机
            this.camera = new THREE.PerspectiveCamera(
                45,
                container.clientWidth / container.clientHeight,
                0.1,
                1000
            );

            // 添加光照
            this.setupLighting();

            // 添加相机父对象用于旋转控制
            this.camera.parent = new THREE.Object3D();
            this.scene.add(this.camera.parent);
            this.camera.position.set(0, 1.5, 3);

            // 初始化拖动控制器
            this.dragController = new DragController(this.renderer, this.camera, this.scene);

            // 处理窗口大小变化
            window.addEventListener('resize', this.onWindowResize.bind(this));

            this.isInitialized = true;
            console.log('MMD3D 管理器初始化完成');
            
            // 自动加载默认模型
            await this.loadDefaultModel();
            
            // 开始渲染循环
            this.startRenderLoop();
            
        } catch (error) {
            console.error('MMD3D 初始化失败:', error);
            throw error;
        }
    }

    setupLighting() {
        // 环境光
        const ambientLight = new THREE.AmbientLight(0x404040, 0.6);
        this.scene.add(ambientLight);

        // 主光源
        const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
        directionalLight.position.set(5, 10, 5);
        directionalLight.castShadow = true;
        directionalLight.shadow.mapSize.width = 2048;
        directionalLight.shadow.mapSize.height = 2048;
        directionalLight.shadow.camera.near = 0.1;
        directionalLight.shadow.camera.far = 50;
        directionalLight.shadow.camera.left = -10;
        directionalLight.shadow.camera.right = 10;
        directionalLight.shadow.camera.top = 10;
        directionalLight.shadow.camera.bottom = -10;
        this.scene.add(directionalLight);

        // 辅助光源
        const fillLight = new THREE.DirectionalLight(0xffffff, 0.3);
        fillLight.position.set(-5, 5, -5);
        this.scene.add(fillLight);
    }

    // 加载默认模型（three-mmd示例中的miku模型）
    async loadDefaultModel() {
        try {
            await this.loadModel(this.defaultModelPath, this.defaultAnimationPath);
        } catch (error) {
            console.error('加载默认模型失败:', error);
            this.onStatusUpdate?.('默认模型加载失败');
        }
    }

    // 加载 PMD/VMD 模型（基于three-mmd示例）
    async loadModel(modelPath, animationPath = null) {
        try {
            console.log(`开始加载 3D 模型: ${modelPath}`);
            this.onStatusUpdate?.('正在加载 3D 模型...');

            // 清理之前的模型
            if (this.currentModel) {
                this.disposeCurrentModel();
            }

            // 确保MMDLoader已加载
            if (typeof MMDLoader === 'undefined' && typeof window.MMDLoader === 'undefined') {
                throw new Error('MMDLoader 未加载');
            }

            // 获取MMDLoader类
            const MMDLoaderClass = window.MMDLoader || MMDLoader;
            
            // 创建加载器
            const loader = new MMDLoaderClass();
            
            // 加载PMD模型
            const modelFullPath = modelPath.startsWith('/') ? modelPath : `/${modelPath}`;
            
            // 加载模型并同时加载动画（如果提供）
            let onProgress = (progress) => {
                console.log(`加载进度: ${progress.loaded} / ${progress.total}`);
                this.onStatusUpdate?.(`加载进度: ${Math.floor((progress.loaded / progress.total) * 100)}%`);
            };
            
            let onError = (error) => {
                console.error('模型加载错误:', error);
                this.onStatusUpdate?.('模型加载出错');
            };

            // PMD加载的Promise包装
            const loadPMD = () => new Promise((resolve, reject) => {
                loader.load(
                    modelFullPath, 
                    (object) => resolve(object), 
                    onProgress, 
                    onError
                );
            });

            // 加载VMD动画的Promise包装
            const loadVMD = (animationPath) => new Promise((resolve, reject) => {
                if (!animationPath) {
                    resolve(null);
                    return;
                }
                
                const VMDLoaderClass = window.VMDLoader || VMDLoader;
                const vmdLoader = new VMDLoaderClass();
                const animationFullPath = animationPath.startsWith('/') ? animationPath : `/${animationPath}`;
                
                vmdLoader.load(
                    animationFullPath, 
                    (vmd) => resolve(vmd), 
                    onProgress, 
                    onError
                );
            });

            // 加载模型和动画
            const [model, vmdAnimation] = await Promise.all([
                loadPMD(),
                loadVMD(animationPath)
            ]);
            
            this.currentModel = model;
            
            // 如果有VMD动画，应用动画
            if (vmdAnimation) {
                if (typeof MMDAnimationHelper === 'undefined' && typeof window.MMDAnimationHelper === 'undefined') {
                    console.warn('MMDAnimationHelper 未加载，无法应用动画');
                } else {
                    const MMDAnimationHelperClass = window.MMDAnimationHelper || MMDAnimationHelper;
                    const helper = new MMDAnimationHelperClass();
                    
                    // 添加模型到助手
                    helper.add(this.currentModel, {
                        animation: vmdAnimation,
                        speed: 1.0,
                        offset: 0.0,
                        primary: true,
                        loop: true,
                    });
                    
                    // 将助手保存以便渲染时使用
                    this.mmdHelper = helper;
                }
            }
            
            // 将模型添加到场景
            this.scene.add(this.currentModel);
            
            // 调整模型位置和大小
            this.adjustModelTransform();
            
            console.log('3D 模型加载完成');
            this.onStatusUpdate?.('3D 模型加载完成');
            this.onModelLoaded?.(this.currentModel);
            
        } catch (error) {
            console.error('3D 模型加载失败:', error);
            this.onStatusUpdate?.('3D 模型加载失败');
            throw error;
        }
    }

    adjustModelTransform() {
        if (!this.currentModel) return;

        // 计算模型的包围盒
        const box = new THREE.Box3().setFromObject(this.currentModel);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        
        // 居中模型
        this.currentModel.position.sub(center);
        
        // 缩放到合适大小（假设1.6米高度）
        const targetHeight = 1.6;
        const currentHeight = size.y;
        const scale = targetHeight / currentHeight;
        this.currentModel.scale.multiplyScalar(scale);
        
        // 重新计算包围盒
        box.setFromObject(this.currentModel);
        const newCenter = box.getCenter(new THREE.Vector3());
        
        // 将模型放在地面上
        this.currentModel.position.y -= newCenter.y;
    }

    // 开始口型同步
    async startMouthSync() {
        try {
            if (!this.modelAdapter) {
                throw new Error('模型未加载');
            }

            if (!this.mouthController) {
                this.mouthController = new MouthController(this.modelAdapter);
                await this.mouthController.initialize();
            }

            // 获取麦克风权限
            const stream = await navigator.mediaDevices.getUserMedia({ 
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false
                }
            });
            
            await this.mouthController.startAudioAnalysis(stream);
            console.log('口型同步已启动');
            
        } catch (error) {
            console.error('口型同步启动失败:', error);
            throw error;
        }
    }

    // 停止口型同步
    stopMouthSync() {
        if (this.mouthController) {
            this.mouthController.stop();
            this.mouthController = null;
            console.log('口型同步已停止');
        }
    }

    // 开始渲染循环
    startRenderLoop() {
        if (this.isRunning) return;
        
        this.isRunning = true;
        
        const animate = () => {
            if (!this.isRunning) return;
            
            requestAnimationFrame(animate);
            
            // 更新拖动控制
            if (this.dragController) {
                this.dragController.update();
            }
            
            // 渲染场景
            if (this.renderer && this.scene && this.camera) {
                this.renderer.render(this.scene, this.camera);
            }
        };
        
        animate();
    }

    // 停止渲染循环
    stopRenderLoop() {
        this.isRunning = false;
    }

    // 处理窗口大小变化
    onWindowResize() {
        if (!this.renderer || !this.camera) return;
        
        const container = document.getElementById(this.containerId);
        const width = container.clientWidth;
        const height = container.clientHeight;
        
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        
        this.renderer.setSize(width, height);
    }

    // 清理当前模型
    disposeCurrentModel() {
        if (this.currentModel) {
            this.scene.remove(this.currentModel);
            
            // 递归清理几何体和材质
            this.currentModel.traverse((child) => {
                if (child.isMesh) {
                    child.geometry.dispose();
                    if (child.material) {
                        if (Array.isArray(child.material)) {
                            child.material.forEach(mat => mat.dispose());
                        } else {
                            child.material.dispose();
                        }
                    }
                }
            });
            
            this.currentModel = null;
            this.modelAdapter = null;
        }
    }

    // 销毁管理器
    dispose() {
        this.stopRenderLoop();
        this.stopMouthSync();
        this.disposeCurrentModel();
        
        if (this.dragController) {
            this.dragController.dispose();
            this.dragController = null;
        }
        
        if (this.renderer) {
            this.renderer.dispose();
            this.renderer = null;
        }
        
        window.removeEventListener('resize', this.onWindowResize.bind(this));
        
        this.isInitialized = false;
        console.log('MMD3D 管理器已销毁');
    }

    // 设置事件回调
    setCallbacks({ onModelLoaded, onStatusUpdate }) {
        this.onModelLoaded = onModelLoaded;
        this.onStatusUpdate = onStatusUpdate;
    }

    // 获取当前模型信息
    getModelInfo() {
        if (!this.currentModel) return null;
        
        const box = new THREE.Box3().setFromObject(this.currentModel);
        const size = box.getSize(new THREE.Vector3());
        
        return {
            hasModel: true,
            boundingBox: {
                width: size.x,
                height: size.y,
                depth: size.z
            }
        };
    }
}

// 创建全局实例
const mmd3DManager = new MMD3DManager();
// 注意：Live2DManager 实例在 live2d.js 中定义和导出

// 导出到全局作用域
window.mmd3DManager = mmd3DManager;
window.MMD3DManager = MMD3DManager; // 确保类定义也可访问

// 注意：Live2DManager 从 live2d.js 文件导出
// 如果需要，可以通过 window.Live2DManager 访问（如果它在 live2d.js 中被导出）

// 确保全局变量 motionTimer3D 存在
if (typeof window.motionTimer3D === 'undefined') {
    window.motionTimer3D = null;
}

// 统一的初始化方法，支持2D和3D模式
window.initCharacter = async function(canvasId, containerId, options = {}) {
    const mode = options.mode || '2d'; // '2d' 或 '3d'
    
    if (mode === '3d') {
        console.log('初始化3D MMD模式');
        is3DMode = true;
        return await mmd3DManager.init3D(canvasId, containerId);
    } else {
        console.log('初始化2D Live2D模式');
        is3DMode = false;
        return await live2DManager.initPIXI(canvasId, containerId, options);
    }
};

// 统一的模型加载方法
window.loadCharacterModel = async function(modelPath, options = {}) {
    if (is3DMode) {
        return await mmd3DManager.loadModel(modelPath);
    } else {
        return await live2DManager.loadModel(modelPath);
    }
};

// 统一的表情播放方法
window.playCharacterExpression = async function(emotion) {
    if (is3DMode) {
        console.log(`3D模式：记录情感 ${emotion}（不支持表情播放）`);
    } else {
        await live2DManager.playExpression(emotion);
    }
};

// 统一的动作播放方法
window.playCharacterMotion = async function(emotion) {
    if (is3DMode) {
        console.log(`3D模式：记录情感 ${emotion}（不支持动作播放）`);
    } else {
        await live2DManager.playMotion(emotion);
    }
};

// 统一的口型同步方法
window.startCharacterMouthSync = async function() {
    if (is3DMode) {
        await mmd3DManager.startMouthSync();
    } else {
        await live2DManager.startMouthSync();
    }
};

window.stopCharacterMouthSync = function() {
    if (is3DMode) {
        mmd3DManager.stopMouthSync();
    } else {
        live2DManager.stopMouthSync();
    }
};

// 页面加载完成后自动初始化
document.addEventListener('DOMContentLoaded', () => {
    console.log('角色系统已就绪 - 支持 Live2D 和 MMD 3D');
    console.log('使用方法：');
    console.log('1. initCharacter("canvasId", "containerId", {mode: "2d"}) - 初始化 Live2D');
    console.log('2. initCharacter("canvasId", "containerId", {mode: "3d"}) - 初始化 MMD 3D');
    console.log('3. loadCharacterModel("/path/to/model") - 加载模型');
    console.log('4. playCharacterExpression("happy") - 播放表情');
    console.log('5. playCharacterMotion("happy") - 播放动作');
    console.log('6. startCharacterMouthSync() - 启动口型同步');
    
    // 如果需要，自动初始化3D模式并加载普拉娜模型
    setTimeout(async () => {
        const canvas = document.querySelector('canvas');
        const container = canvas?.parentElement;
        if (canvas && container) {
            try {
                await initCharacter(canvas.id, container.id, {mode: '3d'});
                console.log('已自动初始化MMD 3D模式并加载普拉娜模型');
            } catch (error) {
                console.warn('自动初始化失败:', error);
            }
        }
    }, 1000);
});

console.log('Live3D + MMD 3D 支持已加载 - 基于 three-mmd-0.0.5');
