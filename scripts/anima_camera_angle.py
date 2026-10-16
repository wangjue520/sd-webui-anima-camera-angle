"""
Anima 相机控制 (Camera Angle) — WebUI 扩展
移植自 ComfyUI 插件 Comfyui-Anima_camera_angle (MIT)
https://github.com/xunying7860/Comfyui-Anima_camera_angle

在 txt2img / img2img 页面提供 3D 可视化相机角度控件，
根据相机位置生成带权重的结构化相机提示词并附加到正面提示词。
"""
import copy
import json
import math

import gradio as gr

from modules import scripts
from modules.ui_components import InputAccordion

# 默认标签配置（与原 ComfyUI 节点一致）
DEFAULT_TAGS = {
    "azimuth": {
        "directions": {
            "front": {"tag": "from front"}, "back": {"tag": "from behind"},
            "left": {"tag": "facing right"}, "right": {"tag": "facing left"},
        },
        "enabled": True, "weight": 10.0, "extra": 0.0, "deadzone_ratio": 0.05,
    },
    "elevation": {
        "categories": {
            "high": {"tag": "high angle"},
            "eye": {"tag": "eye-level"},
            "low": {"tag": "low angle"},
        },
        "enabled": True, "extra": 0.0,
    },
    "distance": {
        "categories": {
            "ecu": {"tag": "extreme close-up"}, "cu": {"tag": "close-up"},
            "medium": {"tag": "medium shot"}, "cowboy_shot": {"tag": "cowboy shot"},
            "full": {"tag": "full body"}, "wide": {"tag": "wide shot"},
        },
        "enabled": True, "extra": 0.0,
    },
    "tilt": {
        "dutch_tag": "dutch angle",
        "enabled": True, "extra": 0.0, "deadzone": 0.15,
    },
    "extra_master": 1.0,
    "weight_max": 10.0,
    "weight_min": 0.1,
    "xy_mult_enabled": True, "xy_mult": 10.0,
}

DEFAULT_EXTRAS = {
    "lens": {"enabled": False, "value": "85mm lens"},
    "dof": {"enabled": False, "value": "shallow depth of field", "weight": 1.3},
    "movement": {"enabled": False, "value": "handheld camera"},
    "composition": {"enabled": False, "value": "rule of thirds"},
    "style": {"enabled": False, "value": "cinematic"},
}


def _deep_merge(base, override):
    for k, v in override.items():
        if k in base and isinstance(base[k], dict) and isinstance(v, dict):
            _deep_merge(base[k], v)
        else:
            base[k] = v
    return base


def _fmt_weight(w):
    return f"{round(float(w), 2):.2f}"


def _split_tags(tag):
    return [t.strip() for t in str(tag).split(",") if t.strip()]


def _emit_weighted(tag, w):
    return [f"({t}:{_fmt_weight(w)})" for t in _split_tags(tag)]


def _elevation_key(y):
    if y > 0.2:
        return "high"
    if y >= -0.2:
        return "eye"
    return "low"


def _distance_key(z):
    if z > 0.7:
        return "ecu"
    if z > 0.2:
        return "cu"
    if z > 0.0:
        return "medium"
    if z > -0.35:
        return "cowboy_shot"
    if z >= -0.7:
        return "full"
    return "wide"


def compute_camera_prompt(pos_x, pos_y, pos_z, roll, tags_json="{}", extra_config=""):
    """移植自 CameraAngleNode.execute，算法与原节点保持一致"""
    pos_x = max(-1.0, min(1.0, float(pos_x)))
    pos_y = max(-1.0, min(1.0, float(pos_y)))
    pos_z = max(-1.0, min(1.0, float(pos_z)))
    roll = max(0.0, min(1.0, float(roll)))

    # 加载配置（标签 + 权重参数）
    tags = copy.deepcopy(DEFAULT_TAGS)
    if tags_json and tags_json != "{}":
        try:
            td = json.loads(tags_json)
            if isinstance(td, dict):
                _deep_merge(tags, td)
        except Exception:
            pass

    # 读取配置值（带安全兜底）
    wmin = float(tags.get("weight_min", 0.1))
    wmax = float(tags.get("weight_max", 10.0))
    em = float(tags.get("extra_master", 1.0))
    xy_mult_enabled = tags.get("xy_mult_enabled", False)
    xy_mult = float(tags.get("xy_mult", 10.0))
    az_weight = float(tags.get("azimuth", {}).get("weight", 10.0))
    az_extra = float(tags.get("azimuth", {}).get("extra", 0.0))
    az_dz = float(tags.get("azimuth", {}).get("deadzone_ratio", 0.05))
    el_extra = float(tags.get("elevation", {}).get("extra", 10.0))
    di_extra = float(tags.get("distance", {}).get("extra", 0.0))
    ti_extra = float(tags.get("tilt", {}).get("extra", 0.0))

    # 加载额外提示词
    extras = copy.deepcopy(DEFAULT_EXTRAS)
    if extra_config:
        try:
            ec = json.loads(extra_config)
            if "extras" in ec:
                extras.update(ec["extras"])
        except Exception:
            pass

    parts = []

    # ---------- 方位 ----------
    az_tag = tags.get("azimuth", {})
    if az_tag.get("enabled", True):
        az = float(pos_x) * math.pi
        front = max(0.0, math.cos(az))
        back = max(0.0, -math.cos(az))
        right = max(0.0, math.sin(az))
        left = max(0.0, -math.sin(az))
        s = front + back + left + right
        if s > 0:
            front /= s
            back /= s
            left /= s
            right /= s
        AZ_POLE = 0.9
        az_gate = max(0.0, min(1.0, (1.0 - abs(pos_y)) / (1.0 - AZ_POLE)))
        az_budget = (az_weight + az_extra * em) * az_gate
        cur_max = wmax
        if xy_mult_enabled:
            az_budget = (xy_mult + az_extra * em) * az_gate
            cur_max = max(wmax, xy_mult)
        for name, ratio in (("front", front), ("back", back), ("left", left), ("right", right)):
            w = ratio * az_budget
            if ratio <= 0 or w < az_dz:
                continue
            w = min(cur_max + max(0.0, az_extra * em), max(wmin, w))
            parts.extend(_emit_weighted(az_tag["directions"][name]["tag"], w))

    # ---------- 高度（3 档） ----------
    el_tag = tags.get("elevation", {})
    if el_tag.get("enabled", True):
        elev_key = _elevation_key(pos_y)
        elev_cat = el_tag.get("categories", {}).get(elev_key)
        if elev_cat and elev_cat.get("tag"):
            el_base_mult = 15.0 if elev_key == "eye" else 10.0
            if xy_mult_enabled:
                el_base_mult = xy_mult
            ew = abs(pos_y) * el_base_mult + em * el_extra
            if ew >= az_dz:
                cap = (max(wmax, xy_mult) if xy_mult_enabled else wmax) + max(0.0, el_extra * em)
                ew = min(cap, max(wmin, ew))
                parts.extend(_emit_weighted(elev_cat["tag"], ew))

    # ---------- 距离 ----------
    di_tag = tags.get("distance", {})
    if di_tag.get("enabled", True):
        dist_key = _distance_key(pos_z)
        dist_cat = di_tag.get("categories", {}).get(dist_key)
        if dist_cat and dist_cat.get("tag"):
            dw = 1.0 + em * di_extra
            parts.extend(_emit_weighted(dist_cat["tag"], min(wmax + max(0.0, di_extra * em), max(0.1, dw))))

    # ---------- 倾斜 ----------
    ti_tag = tags.get("tilt", {})
    if ti_tag.get("enabled", True) and float(roll) > 0:
        tw = 1.0 + em * ti_extra
        parts.extend(_emit_weighted(ti_tag.get("dutch_tag", ""), min(wmax + max(0.0, ti_extra * em), max(0.1, tw))))

    # ---------- 额外提示词 ----------
    for key in ("lens", "dof", "movement", "composition", "style"):
        e = extras.get(key)
        if not e or not e.get("enabled"):
            continue
        val = (e.get("value") or "").strip()
        if not val:
            continue
        if key == "dof":
            parts.append(f"({val}:{_fmt_weight(e.get('weight', 1.3))})")
        else:
            parts.append(val)

    # 从 extra_config 解析 extreme 标签（直通，无 pos_y 限制）
    if extra_config:
        try:
            ec = json.loads(extra_config)
            if "extreme_high" in ec:
                eh = ec["extreme_high"]
                if isinstance(eh, dict) and eh.get("tag", "").strip():
                    parts.extend(_emit_weighted(eh["tag"], float(eh.get("weight", 10.0))))
            if "extreme_low" in ec:
                el = ec["extreme_low"]
                if isinstance(el, dict) and el.get("tag", "").strip():
                    parts.extend(_emit_weighted(el["tag"], float(el.get("weight", 10.0))))
        except Exception:
            pass

    return ", ".join(parts)


def build_extra_config(extreme_type, extreme_weight,
                       lens_enabled, lens_value,
                       dof_enabled, dof_value, dof_weight,
                       movement_enabled, movement_value,
                       composition_enabled, composition_value,
                       style_enabled, style_value):
    """对应原 CameraExtraConfigNode 的输出 JSON"""
    cfg = {
        "extras": {
            "lens": {"enabled": bool(lens_enabled), "value": lens_value},
            "dof": {"enabled": bool(dof_enabled), "value": dof_value, "weight": float(dof_weight)},
            "movement": {"enabled": bool(movement_enabled), "value": movement_value},
            "composition": {"enabled": bool(composition_enabled), "value": composition_value},
            "style": {"enabled": bool(style_enabled), "value": style_value},
        },
    }
    if extreme_type == "极限俯视":
        cfg["extreme_high"] = {"tag": "extreme high-angle shot", "weight": float(extreme_weight)}
    elif extreme_type == "极限仰视":
        cfg["extreme_low"] = {"tag": "extreme low-angle shot", "weight": float(extreme_weight)}
    return json.dumps(cfg, ensure_ascii=False)


class Script(scripts.Script):
    def title(self):
        return "Anima 相机控制"

    def show(self, is_img2img):
        return scripts.AlwaysVisible

    def ui(self, is_img2img):
        tab = "img2img" if is_img2img else "txt2img"

        def eid(name):
            return f"anima_cam_{name}_{tab}"

        with InputAccordion(False, label="Anima 相机控制 (Camera Angle)", elem_id=eid("accordion")) as enabled:
            # 3D 控件挂载点（由 javascript/anima_camera.js 填充）
            gr.HTML(f'<div id="{eid("mount")}" class="anima-cam3d-mount" data-tab="{tab}"></div>')

            position = gr.Dropdown(choices=["末尾", "开头"], value="末尾", label="相机提示词附加位置", elem_id=eid("position"))

            # 隐藏状态框：3D 控件通过 JS 写入，生成时随参数发送到后端
            with gr.Group(elem_classes=["anima-cam-hidden"]):
                pos_x = gr.Textbox(value="0", elem_id=eid("pos_x"))
                pos_y = gr.Textbox(value="0", elem_id=eid("pos_y"))
                pos_z = gr.Textbox(value="0", elem_id=eid("pos_z"))
                roll = gr.Textbox(value="0", elem_id=eid("roll"))
                tags_json = gr.Textbox(value="{}", elem_id=eid("tags_json"))

            with gr.Accordion("额外提示词 (Extra Prompts)", open=False):
                with gr.Row():
                    extreme_type = gr.Dropdown(choices=["无", "极限俯视", "极限仰视"], value="无", label="极限角度", scale=2)
                    extreme_weight = gr.Slider(0.1, 50.0, value=10.0, step=0.5, label="极限角度权重", scale=1)
                with gr.Row():
                    lens_enabled = gr.Checkbox(False, label="启用镜头", scale=1)
                    lens_value = gr.Textbox(value="85mm lens", label="镜头/焦距", scale=3)
                with gr.Row():
                    dof_enabled = gr.Checkbox(False, label="启用景深", scale=1)
                    dof_value = gr.Textbox(value="shallow depth of field", label="景深文案", scale=2)
                    dof_weight = gr.Slider(0.1, 10.0, value=1.3, step=0.1, label="景深权重", scale=1)
                with gr.Row():
                    movement_enabled = gr.Checkbox(False, label="启用运镜", scale=1)
                    movement_value = gr.Textbox(value="handheld camera", label="运镜文案", scale=3)
                with gr.Row():
                    composition_enabled = gr.Checkbox(False, label="启用构图", scale=1)
                    composition_value = gr.Textbox(value="rule of thirds", label="构图文案", scale=3)
                with gr.Row():
                    style_enabled = gr.Checkbox(False, label="启用风格", scale=1)
                    style_value = gr.Textbox(value="cinematic", label="风格文案", scale=3)

        self.infotext_fields = [
            (enabled, "Anima Camera"),
            (pos_x, "Anima Camera pos_x"),
            (pos_y, "Anima Camera pos_y"),
            (pos_z, "Anima Camera pos_z"),
            (roll, "Anima Camera roll"),
            (tags_json, "Anima Camera tags"),
            (position, "Anima Camera position"),
            (extreme_type, "Anima Camera extreme"),
            (extreme_weight, "Anima Camera extreme weight"),
            (lens_enabled, "Anima Camera lens"),
            (lens_value, "Anima Camera lens value"),
            (dof_enabled, "Anima Camera dof"),
            (dof_value, "Anima Camera dof value"),
            (dof_weight, "Anima Camera dof weight"),
            (movement_enabled, "Anima Camera movement"),
            (movement_value, "Anima Camera movement value"),
            (composition_enabled, "Anima Camera composition"),
            (composition_value, "Anima Camera composition value"),
            (style_enabled, "Anima Camera style"),
            (style_value, "Anima Camera style value"),
        ]
        self.paste_field_names = [name for _, name in self.infotext_fields]

        return [
            enabled,
            pos_x, pos_y, pos_z, roll, tags_json,
            position,
            extreme_type, extreme_weight,
            lens_enabled, lens_value,
            dof_enabled, dof_value, dof_weight,
            movement_enabled, movement_value,
            composition_enabled, composition_value,
            style_enabled, style_value,
        ]

    def process(self, p, enabled,
                pos_x, pos_y, pos_z, roll, tags_json,
                position,
                extreme_type, extreme_weight,
                lens_enabled, lens_value,
                dof_enabled, dof_value, dof_weight,
                movement_enabled, movement_value,
                composition_enabled, composition_value,
                style_enabled, style_value):
        if not enabled:
            return

        try:
            px, py, pz, rv = float(pos_x), float(pos_y), float(pos_z), float(roll)
        except (TypeError, ValueError):
            return

        extra_config = build_extra_config(
            extreme_type, extreme_weight,
            lens_enabled, lens_value,
            dof_enabled, dof_value, dof_weight,
            movement_enabled, movement_value,
            composition_enabled, composition_value,
            style_enabled, style_value,
        )

        cam_prompt = compute_camera_prompt(px, py, pz, rv, tags_json or "{}", extra_config)
        if not cam_prompt:
            return

        at_end = position != "开头"

        def merge(prompt):
            if not prompt or not prompt.strip():
                return cam_prompt
            return f"{prompt}, {cam_prompt}" if at_end else f"{cam_prompt}, {prompt}"

        if isinstance(p.all_prompts, list):
            p.all_prompts = [merge(pr) for pr in p.all_prompts]
            if p.all_prompts:
                p.main_prompt = p.all_prompts[0]

        hr_prompts = getattr(p, "all_hr_prompts", None)
        if getattr(p, "enable_hr", False) and isinstance(hr_prompts, list):
            p.all_hr_prompts = [merge(pr) for pr in hr_prompts]

        p.extra_generation_params["Anima Camera"] = f"pos=({px}, {py}, {pz}), roll={rv}"
