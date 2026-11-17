import numpy as np, cv2, json, os, sys
D='/home/claude/render/hall_out'; OUT=sys.argv[1] if len(sys.argv)>1 else '/home/claude/mb-world'
def to_srgb(x):
    x=np.clip(x,0,1); return np.where(x<=0.0031308,x*12.92,1.055*np.power(x,1/2.4)-0.055)
info={'k':1.0}
for name,key,h in [('floor_lm','floor',6),('props_lm','props',7)]:
    px=np.load(os.path.join(D,name+'.npy'))[::-1]  # flip to top-down
    rgb=px[...,:3]; lum=rgb.mean(-1); v=lum[lum>1e-4]
    p99=np.percentile(v,99.3) if v.size else 1.0; s=0.9/max(p99,1e-6)
    img=(to_srgb(rgb*s)*255+.5).astype(np.uint8)[...,::-1]
    den=cv2.fastNlMeansDenoisingColored(img,None,h,h,7,21)
    den=cv2.bilateralFilter(den,7,18,5)
    cv2.imwrite(os.path.join(OUT,f'hall_{key}_lm.jpg'),den,[cv2.IMWRITE_JPEG_QUALITY,90])
    info[key]=float(1/s); print(name,'p99',p99,'scale',s)
json.dump(info,open(os.path.join(OUT,'hall_bake.json'),'w'))
print(info)
