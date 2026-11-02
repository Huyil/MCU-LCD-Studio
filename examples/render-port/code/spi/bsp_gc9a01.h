#ifndef __bsp_gc9a01_H__
#define __bsp_gc9a01_H__


#include "bsp_spiHost.h"
#define LCD_4W(i)

/* GC9A01 为 1.28 寸 240x240 圆屏，坐标 0~239，无需像 ST7735S 那样加 +32 偏移 */
#define LCD_W 240
#define LCD_H 240

#define RGB888(R, G, B) (((R >> 3) << 11) | ((G >> 2) << 5) | (B >> 3))
#define RGB565(R, G, B) (((R & 0x1F) << 11) | ((G & 0x3F) << 5) | (B & 0x1F))
#define RGB565_SWAP(R, G, B) (((R & 0x1F) << 3) | ((G & 0x38) >> 3) | ((G & 0x07) << 13) | ((B & 0x1F)<<8))
#define SWAP_RGB565(rgb) (((uint16_t)(rgb>>8)) | (((uint16_t)rgb)<<8))
// 定义RGB565解码宏
#define R565(rgb)  (((rgb) >> 11) & 0x1F)
#define G565(rgb)  (((rgb) >> 5) & 0x3F)
#define B565(rgb)  ((rgb) & 0x1F)

//画笔颜色
// 方法1: 标准枚举
typedef enum {
    DARKBLUE  =	0X01CF,	 //深蓝色
    GRAYBLUE  =	0X5458,  //灰蓝色
    ALMOND_BLANCHED	=	0xFF59,           //杏仁白
    AMBER	=	0xFDE0,                     //琥珀色
    AMETHYST	=	0x6199,                 //紫水晶色
    APRICOT	=	0xE4CC,                   //杏黄
    AQUA	=	0xAEFC,                     //水色
    AQUAMARINE	=	0x7FFA,               //碧蓝色
    AQUAMARINE_MEDIUM	=	0x6675,         //中碧蓝色
    AZURE	=	0x03FF,                     //湛蓝
    BEIGE	=	0xF7BB,                     //米黄色
    BEIGE_SAND	=	0xE618,               //沙棕
    BISQUE	=	0xFF38,                   //陶坯黄
    BLACK	=	0x0000,                     //黑色
    BLUE	=	0x001F,                     //蓝色
    BLUE_ALICE	=	0xF7DF,               //爱丽丝蓝
    BLUE_AQUA	=	0x67FC,                 //水蓝
    BLUE_BABY	=	0xE7FF,                 //浅蓝
    BLUE_CADET	=	0x5CF4,               //军服蓝
    BLUE_CERULEAN	=	0x2A97,             //蔚蓝
    BLUE_COBALT	=	0x0235,               //钴蓝
    BLUE_CORNFLOWER	=	0x64BD,           //矢车菊蓝
    BLUE_CYAN	=	0x0DF1,                 //青蓝
    BLUE_DARK	=	0x0011,                 //暗蓝
    BLUE_DODGER	=	0x1C9F,               //道奇蓝
    BLUE_HORIZON	=	0xA7F9,             //苍色
    BLUE_INTERNATIONAL_KLEIN	=	0x0174, //国际奇连蓝
    BLUE_LAPIS	=	0x099F,               //天青石蓝
    BLUE_LIGHT	=	0xAEDC,               //亮蓝
    BLUE_MARINE	=	0x022F,               //水手蓝
    BLUE_MEDIUM	=	0x0019,               //中蓝
    BLUE_MIDNIGHT	=	0x18CE,             //午夜蓝
    BLUE_MINERAL	=	0x0273,             //矿蓝
    BLUE_MINERAL_DARK	=	0x21AF,         //暗矿蓝
    BLUE_NAVY	=	0x0010,                 //藏青
    BLUE_PALE	=	0x7DD9,                 //灰蓝
    BLUE_PEACOCK	=	0x0411,             //孔雀蓝
    BLUE_POWDER	=	0xB71C,               //婴儿粉蓝
    BLUE_POWDER_DARK	=	0x0193,         //暗婴儿粉蓝
    BLUE_PRUSSIAN	=	0x018A,             //普鲁士蓝
    BLUE_ROYAL	=	0x435C,               //品蓝
    BLUE_SALVIA	=	0x4C1C,               //鼠尾草蓝
    BLUE_SAXE	=	0x44D6,                 //萨克斯蓝
    BLUE_SKY	=	0x867D,                 //天蓝
    BLUE_SKY_DEEP	=	0x05FF,             //深天蓝
    BLUE_SKY_LIGHT	=	0x867F,           //亮天蓝
    BLUE_SLATE	=	0x6AD9,               //岩蓝
    BLUE_SLATE_DARK	=	0x49F1,           //暗岩蓝
    BLUE_SLATE_MEDIUM	=	0x7B5D,         //中岩蓝
    BLUE_STEEL	=	0x4416,               //钢青色
    BLUE_STEEL_LIGHT	=	0xB63B,         //亮钢蓝
    BLUE_STRONG	=	0x030E,               //浓蓝
    BLUE_TURQUOISE	=	0x3739,           //绿松石蓝
    BLUE_WEDGWOOD	=	0x5437,             //韦奇伍德瓷蓝
    BLUSH_LAVENDER	=	0xFF9E,           //薰衣草紫红
    BRICK_FIRE	=	0xB104,               //耐火砖红
    BRONZE	=	0xBB86,                   //古铜色
    BROWN	=	0xA145,                     //褐色
    BROWN_COCONUT	=	0x48E0,             //椰褐
    BROWN_ROSY	=	0xBC71,               //玫瑰褐
    BROWN_SADDLE	=	0x8A22,             //鞍褐
    BROWN_SAND	=	0xF52C,               //沙褐
    BURGUNDY	=	0x4004,                 //勃艮第酒红
    CAMEL	=	0xA348,                     //驼色
    CAMELLIA	=	0xE1D2,                 //山茶红
    CARMINE	=	0xE00B,                   //胭脂红
    CERISE	=	0xD98C,                   //樱桃红
    CHARTREUSE	=	0x7FE0,               //查特酒绿
    CHIFFON_LEMON	=	0xFFD9,             //柠檬绸色
    CHOCOLATE	=	0xD343,                 //巧克力色
    CLEMATIS	=	0xCD19,                 //铁线莲紫
    COFFEE	=	0x49C0,                   //咖啡色
    CORAL	=	0xFBEA,                     //珊瑚红
    CORAL_LIGHT	=	0xF410,               //亮珊瑚色
    CORNSILK	=	0xFFDB,                 //玉米丝色
    CREAM	=	0xFFFA,                     //奶油色
    CREAM_MINT	=	0xF7FF,               //薄荷奶油色
    CRIMSON	=	0xD8A7,                   //绯红
    CRIMSON_ALIZARIN	=	0xE126,         //茜红
    CYAN	=	0x07FF,                     //青色
    CYAN_DARK	=	0x0451,                 //暗青
    CYAN_LIGHT	=	0xE7FF,               //亮青
    DENIM_PALE	=	0x5C38,               //灰丁宁蓝
    DRAB_OLIVE	=	0x6C64,               //橄榄军服绿
    EMERALD	=	0x564F,                   //碧绿
    FLAMINGO	=	0xE457,                 //火鹤红
    FUCHSIA	=	0xF014,                   //品红
    GAINSBORO	=	0xDEFA,                 //庚斯博罗灰
    GOLDEN	=	0xFEA0,                   //金色
    GOLDENROD	=	0xDD24,                 //金菊色
    GOLDENROD_DARK	=	0xBC21,           //暗金菊色
    GOLDENROD_PALE	=	0xEF55,           //灰金菊色
    GRAY	=	0x8410,                     //灰色
    GRAY_DARK	=	0xAD55,                 //暗灰
    GRAY_DIM	=	0x6B4D,                 //昏灰
    GRAY_IRON	=	0x62CA,                 //铁灰色
    GRAY_LIGHT	=	0xD69A,               //亮灰色
    GRAY_SLATE	=	0x7412,               //岩灰
    GRAY_SLATE_DARK	=	0x2A69,           //暗岩灰
    GRAY_SLATE_LIGHT	=	0x7453,         //亮岩灰
    GREEN	=	0x0400,                     //绿色
    GREEN_APPLE	=	0x8F20,               //苹果绿
    GREEN_BRIGHT	=	0x67E0,             //明绿
    GREEN_CELADON	=	0x7731,             //青瓷绿
    GREEN_COBALT	=	0x67EB,             //钴绿
    GREEN_DARK	=	0x0320,               //暗绿
    GREEN_FOLIAGE	=	0x75C7,             //叶绿
    GREEN_FOREST	=	0x2444,             //森林绿
    GREEN_GRASS	=	0x9F29,               //草绿
    GREEN_IVY	=	0x35E6,                 //常春藤绿
    GREEN_LAWN	=	0x7FE0,               //草坪绿
    GREEN_LIGHT	=	0x9772,               //亮绿
    GREEN_LIME	=	0x3666,               //柠檬绿
    GREEN_MOSS	=	0x6BA4,               //苔藓绿
    GREEN_OLIVE_DARK	=	0x5345,         //暗橄榄绿
    GREEN_PALE	=	0x9FD3,               //灰绿
    GREEN_PEACOCK	=	0x050B,             //孔雀绿
    GREEN_SEA	=	0x2C4A,                 //海绿
    GREEN_SEA_DARK	=	0x8DF1,           //暗海绿
    GREEN_SEA_LIGHT	=	0x2595,           //亮海绿
    GREEN_SEA_MEDIUM	=	0x3D8E,         //中海绿
    GREEN_SPRING	=	0x07F0,             //春绿
    GREEN_SPRING_MEDIUM	=	0x07D3,       //中春绿色
    GREEN_TURQUOISE	=	0x4F30,           //绿松石绿
    GREEN_YELLOW	=	0x9E66,             //黄绿
    HELIOTROPE	=	0x5017,               //缬草紫
    HONEYDEW	=	0xF7FE,                 //蜜瓜绿
    INDIGO	=	0x4810,                   //靛色
    IVORY	=	0xFFFE,                     //象牙色
    JASMINE	=	0xE60B,                   //茉莉黄
    KHAKI	=	0x9B43,                     //卡其色
    KHAKI_DARK	=	0xBDAD,               //暗卡其色
    KHAKI_LIGHT	=	0xF731,               //亮卡其色
    LACE_OLD	=	0xFFBC,                 //旧蕾丝色
    LAVENDER	=	0xE73F,                 //薰衣草紫
    LEAVES_FRESH	=	0x9FE9,             //嫩绿
    LILAC	=	0xB4DF,                     //紫丁香色
    LILAC_PALE	=	0xE67C,               //淡紫丁香色
    LIME	=	0x07E0,                     //鲜绿色
    LIME_LIGHT	=	0xCFE0,               //亮柠檬绿
    LINEN	=	0xFF9C,                     //亚麻色
    MAGENTA	=	0xF81F,                   //洋红
    MAGENTA_DARK	=	0x8811,             //暗洋红
    MALACHITE	=	0x2605,                 //孔雀石绿
    MALLOW	=	0xDA7F,                   //锦葵紫
    MARIGOLD	=	0xFCC0,                 //万寿菊黄
    MAROON	=	0x8000,                   //栗色
    MAUVE	=	0x621F,                     //木槿紫
    MAUVE_OPERA	=	0xE41F,               //优品紫红
    MIMOSA	=	0xE6C6,                   //含羞草黄
    MINT	=	0x14C5,                     //薄荷绿
    MOCCASIN	=	0xFF36,                 //鹿皮鞋色
    MUSTARD	=	0xCE69,                   //芥末黄
    OCHER	=	0xCBA4,                     //赭色
    OCRE_PALE	=	0xCD91,                 //灰土色
    OLIVE	=	0x8400,                     //橄榄色
    ORANGE	=	0xFD20,                   //橙色
    ORANGE_BURNT	=	0xCAA0,             //燃橙
    ORANGE_DARK	=	0xFC60,               //暗橙
    ORANGE_HONEY	=	0xFD8C,             //蜜橙
    ORANGE_PERSIMMON	=	0xFA68,         //柿子橙
    ORANGE_SUN	=	0xFB80,               //阳橙
    ORANGE_TROPICAL	=	0xFC06,           //热带橙
    ORCHID	=	0xDB9A,                   //兰紫
    ORCHID_DARK	=	0x9999,               //暗兰紫
    ORCHID_MEDIUM	=	0xBABA,             //中兰紫
    PANSY	=	0x7014,                     //三色堇紫
    PEACH	=	0xFF36,                     //桃色
    PERIWINKLE	=	0xCE7F,               //长春花色
    PERU	=	0xCC27,                     //秘鲁色
    PINK	=	0xFE19,                     //粉红
    PINK_BABY	=	0xFEDC,                 //浅粉红
    PINK_CORAL	=	0xFC17,               //浅珊瑚红
    PINK_DEEP	=	0xF8B2,                 //深粉红
    PINK_HOT	=	0xFB56,                 //暖粉红
    PINK_LIGHT	=	0xFDB8,               //亮粉红
    PINK_PEARL	=	0xFD9C,               //浅珍珠红
    PINK_ROSE	=	0xFB39,                 //浅玫瑰红
    PINK_SALMON	=	0xFC13,               //浅鲑红
    PINK_SHELL	=	0xFD97,               //壳黄红
    PLUM	=	0xDD1B,                     //梅红色
    PUFF_PEACH	=	0xFED7,               //粉扑桃色
    PURPLE	=	0x8010,                   //紫色
    PURPLE_GRAYISH	=	0x83B4,           //浅灰紫红
    PURPLE_MEDIUM	=	0x939B,             //中紫红
    RED	=	0xF800,                       //红色
    RED_CARDINAL	=	0x9806,             //枢机红
    RED_DARK	=	0x8800,                 //暗红
    RED_INDIAN	=	0xCAEB,               //印度红
    RED_ORANGE	=	0xFA20,               //橙红
    RED_SPINEL	=	0xFB96,               //尖晶石红
    RED_STRONG	=	0xE000,               //鲜红
    RED_VIOLET_MEDIUM	=	0xC0B0,         //中青紫红
    RED_VIOLET_PALE	=	0xDB92,           //灰紫红
    ROSE	=	0xF80F,                     //玫瑰红
    ROSE_MAGENTA	=	0xF874,             //洋玫瑰红
    ROSE_MISTY	=	0xFF3C,               //雾玫瑰色
    ROSE_OLD	=	0xBAB3,                 //陈玫红
    RUBY	=	0xC810,                     //红宝石色
    SALMON	=	0xFC0E,                   //鲑红
    SALMON_DARK	=	0xECAF,               //暗鲑红
    SALMON_LIGHT	=	0xFD0F,             //亮鲑红
    SAPPHIRE	=	0x092C,                 //蓝宝石色
    SCARLET	=	0xF920,                   //腥红
    SEASHELL	=	0xFFBD,                 //海贝色
    SEPIA	=	0x7202,                     //乌贼墨色
    SIENNA	=	0xA285,                   //赭黄
    SILVER	=	0xC618,                   //银色
    SMOKE_WHITE	=	0xF7BE,               //白烟色
    SNOW	=	0xFFDF,                     //雪色
    TAN	=	0xD5B1,                       //日晒色
    TANGERINE	=	0xF420,                 //橘色
    TEAL	=	0x0410,                     //凫绿
    THISTLE	=	0xDDFB,                   //蓟紫
    TOMATO	=	0xFB08,                   //蕃茄红
    TURQUOISE	=	0x36B9,                 //绿松石色
    TURQUOISE_DARK	=	0x067A,           //暗绿松石色
    TURQUOISE_MEDIUM	=	0x4E99,         //中绿松石色
    TURQUOISE_PALE	=	0xAF7D,           //灰绿松石色
    ULTRAMARINE	=	0x019F,               //极浓海蓝
    VERIDIAN	=	0x13A6,                 //铬绿
    VERMILION	=	0xFA60,                 //朱红
    VIOLET	=	0x881F,                   //紫罗兰色
    VIOLET_BLUE	=	0x895C,               //蓝紫
    VIOLET_DARK	=	0x901A,               //暗紫
    VIOLET_LIGHT	=	0xEC1D,             //亮紫
    VIOLET_MINERAL	=	0xBD19,           //矿紫
    WHEAT	=	0xF6F6,                     //小麦色
    WHIP_PAPAYA	=	0xFF7A,               //蕃木瓜色
    WHITE	=	0xFFFF,                     //白色
    WHITE_ANTIQUE	=	0xFF5A,             //古董白
    WHITE_FLORAL	=	0xFFDE,             //花卉白
    WHITE_GHOST	=	0xFFDF,               //幽灵白
    WHITE_NAVAJO	=	0xFEF5,             //那瓦霍白
    WISTERIA	=	0x5A9C,                 //紫藤色
    WOOD_BURLY	=	0xDDD0,               //硬木色
    YELLOW	=	0xFFE0,                   //黄色
    YELLOW_CANARY	=	0xFFE0,             //鲜黄
    YELLOW_CHAMPAGNE	=	0xFFF3,         //香槟黄
    YELLOW_CHROME	=	0xE5C0,             //铬黄
    YELLOW_GOLDENROD_LIGHT	=	0xFFDA,   //亮金菊黄
    YELLOW_GREEN	=	0xAFE5,             //绿黄
    YELLOW_LIGHT	=	0xFFFC,             //亮黄
    YELLOW_MOON	=	0xFFE9,               //月黄

} Color_t;


void LCD144_Init(void);         /* 硬复位 + 寄存器 + SLPOUT (不含 DISPON) */
void LCD144_DisplayOn(void);    /* 0x29 DISPON —— LCD_Init 清完屏之后才点 */
void LCD144_Sleep(void);
void LCD144_WakeUp(void);

void HAL_Delay(uint32_t ms);
uint16_t hsv2rgb(float h, float s, float v);

void LCD_Address_Set(uint8_t x1,uint8_t y1,uint8_t x2,uint8_t y2);
void LCD_AddrCacheFlush(void);  /* 休眠/断电后失效地址缓存 */

uint8_t LCD_drawPx(uint8_t xsta, uint8_t ysta, uint16_t color);

/* 画一条水平连续像素 (n 个), color565 为逻辑 RGB565 (函数内部按屏要求的字节序发送)。 */
uint8_t LCD_drawPxRun(uint8_t x, uint8_t y, uint8_t n, uint16_t color565);

/* LCD_Fill 的返回码。调用方习惯只判 "!= 0", 这里细分是为了把"总线忙 (一个
 * 像素都没发)"和"SPI 超时 (只发了一部分)"区分开 —— 花屏现场要靠它定位。 */
#define LCD_IO_OK       0u      /* 全部像素已发出 */
#define LCD_IO_BUSY     1u      /* 屏正被别人画 / 参数非法: 一个像素都没发 */
#define LCD_IO_TIMEOUT  2u      /* SPI 超时: 只发出一部分, 屏内容已不可信 */

uint8_t LCD_Fill(uint8_t xsta, uint8_t ysta, uint8_t xend, uint8_t yend, uint16_t color);
uint8_t LCD_Fill_DMA(uint8_t xsta, uint8_t ysta, uint8_t xend, uint8_t yend, uint16_t color);

/* 调试遥测 (SWD 读): LCD_Fill 因 SPI 超时被截断的次数, 正常恒为 0。
 * 上电花屏现场若它非 0, 就说明"清屏那一笔没发完", 不用再猜。 */
extern volatile uint32_t g_dbgLcdFillIo;

/* pic 用 const void*: 导出的多帧图标 (const uint16_t*) 与内部/外部素材
 * (const uint8_t*) 都能直接传; 驱动按地址区间分流, 不做类型区分。 */
uint8_t LCD_drawImage(uint8_t x, uint8_t y, uint8_t w, uint8_t h, const void* pic, uint16_t color);

/* ---- 圆环逐点渲染专用通路 (与上面旧 LCD_xxx 完全隔离, 旧函数一行未改) ----
 *   LCD_RingBegin()   整帧独占 (busy=1), 期间旧 LCD_xxx 全部返回 1
 *   LCD_RingRun(x,y,n,px) 一次写完一行连续 n 像素 (两阶段出图的写屏阶段)
 *   LCD_RingEnd()     释放, 并让旧地址缓存失效
 * 差别只有两点: ① 每次切 DC/CS 前等 TXE=1 且 BUSY=0 (SPI 手册要求, 防末字节截断);
 * ② 1x1 窗口逐点写 (宽窗口会被面板行扫描读到半写状态 → 横向扫描纹)。 */
void LCD_RingBegin(void);
/* x/y 是 16 位: CASET/RASET 本来就是 16 位坐标 (高字节 0 时与老的 8 位写法逐字节相同),
 * 圆角矩形环在竖屏/横屏上会用到 >255 的行列。n 走 RING_RUN_MAX=64 的分段, 仍是 8 位。 */
uint8_t LCD_RingRun(uint16_t x, uint16_t y, uint8_t n, const uint16_t* px);
void LCD_RingEnd(void);

/* 8bit 灰度图 × 目标颜色 绘制, 支持左右镜像 (mirror=1 左右翻转; 字库/箭头等灰度资源) */
uint8_t LCD_drawGrayImage(uint8_t x, uint8_t y, uint8_t w, uint8_t h, const uint8_t* gray, uint16_t color, uint8_t mirror);

#ifdef USE_W25Q
uint8_t LCD_drawImageFromW25Q_Overlap(uint8_t x, uint8_t y, uint8_t w, uint8_t h, const uint8_t* pic);
uint8_t LCD_drawImageFromW25Q_Overlap_ColorMul(
    uint8_t x, uint8_t y,
    uint8_t w, uint8_t h,
    const uint8_t* pic,
    uint16_t color565
);

uint8_t LCD_drawImageFromW25Q_DMA(uint8_t x, uint8_t y, uint8_t w, uint8_t h, const uint8_t* pic);

/* 8bit 灰度素材在外部 W25Q (字库/掩膜): 逐行读 → 逐行乘色写屏 (共用 SPI 的两阶段).
 * flashAddr 由 LCD_drawGrayImage 按地址区间自动分流, 业务层不用直接调。 */
uint8_t LCD_drawGrayImageFromW25Q(uint8_t x, uint8_t y, uint8_t w, uint8_t h,
                                  const uint8_t* gray, uint16_t color, uint8_t mirror);

#endif
#endif //__bsp_gc9a01_H__


