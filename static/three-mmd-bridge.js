/**
 * three-mmd桥接文件
 * 用于在现有项目中引入three-mmd功能的简化包装
 * 基于 three-mmd-0.0.5
 */

class SimpleMMDLoader {
    constructor() {
        this.manager = new THREE.LoadingManager();
        this.textureLoader = new THREE.TextureLoader(this.manager);
    }

    load(url, onLoad, onProgress, onError) {
        console.log(`SimpleMMDLoader: 加载模型 ${url}`);
        
        // 简单的占位符实现 - 创建基本几何体代替实际PMD
        const geometry = new THREE.BoxGeometry(1, 1, 1);
        const material = new THREE.MeshPhongMaterial({ color: 0x8888ff });
        const mesh = new THREE.Mesh(geometry, material);
        
        // 模拟加载过程
        setTimeout(() => {
            if (onLoad) onLoad(mesh);
        }, 500);
    }
}

class SimpleVMDLoader {
    constructor() {
        this.manager = new THREE.LoadingManager();
    }

    load(url, onLoad, onProgress, onError) {
        console.log(`SimpleVMDLoader: 加载动画 ${url}`);
        
        // 简单的占位符实现
        const mockAnimation = {
            motions: {},
            facialAnimations: {},
            cameraAnimations: {}
        };
        
        setTimeout(() => {
            if (onLoad) onLoad(mockAnimation);
        }, 300);
    }
}

class SimpleMMDAnimationHelper {
    constructor() {
        console.log('SimpleMMDAnimationHelper 初始化');
    }

    add(object, options) {
        console.log('MMDAnimationHelper: 添加对象', options);
        return object;
    }

    update(delta) {
        // 简单的更新实现
    }
}

// 初始化three-mmd桥接
async function initThreeMMD() {
    console.log('正在初始化three-mmd桥接...');
    
    // 检查Three.js是否可用
    if (typeof THREE === 'undefined') {
        console.error('Three.js 未加载');
        return null;
    }

    // 确保全局变量存在
    window.MMDLoader = SimpleMMDLoader;
    window.VMDLoader = SimpleVMDLoader;
    window.MMDAnimationHelper = SimpleMMDAnimationHelper;
    
    console.log('three-mmd桥接初始化完成');
    return {
        MMDLoader: SimpleMMDLoader,
        VMDLoader: SimpleVMDLoader,
        MMDAnimationHelper: SimpleMMDAnimationHelper,
        initAmmo: async () => true
    };
}

// 导出桥接函数
window.initThreeMMD = initThreeMMD;

console.log('three-mmd bridge 加载完成');