import os
import svgwrite
import random
import math

OUTPUT_DIR = "avatars"
os.makedirs(OUTPUT_DIR, exist_ok=True)

def random_color():
    return svgwrite.utils.rgb(
        random.randint(0, 255),
        random.randint(0, 255),
        random.randint(0, 255)
    )

def gradient_avatar(filename, size):
    dwg = svgwrite.Drawing(filename, size=(size, size))
    grad = dwg.linearGradient((0, 0), (1, 1), id="grad")
    grad.add_stop_color(0, random_color())
    grad.add_stop_color(1, random_color())
    dwg.defs.add(grad)
    dwg.add(dwg.rect(insert=(0, 0), size=(size, size), fill="url(#grad)"))
    dwg.save()

def geometric_avatar(filename, size):
    dwg = svgwrite.Drawing(filename, size=(size, size))
    for _ in range(5):
        shape = random.choice(['circle', 'rect', 'polygon'])
        color = random_color()
        if shape == 'circle':
            cx, cy = random.uniform(0, size), random.uniform(0, size)
            r = random.uniform(size*0.1, size*0.3)
            dwg.add(dwg.circle(center=(cx, cy), r=r, fill=color))
        elif shape == 'rect':
            w, h = random.uniform(size*0.2, size*0.5), random.uniform(size*0.2, size*0.5)
            x, y = random.uniform(0, size-w), random.uniform(0, size-h)
            dwg.add(dwg.rect(insert=(x, y), size=(w, h), fill=color))
        else:
            points = [(random.uniform(0, size), random.uniform(0, size)) for _ in range(random.randint(3, 6))]
            dwg.add(dwg.polygon(points, fill=color))
    dwg.save()

def line_art_avatar(filename, size):
    dwg = svgwrite.Drawing(filename, size=(size, size))
    points = [(x, size/2 + math.sin(x/20)*size/6) for x in range(0, size+1, 5)]
    dwg.add(dwg.polyline(points, stroke=random_color(), fill='none', stroke_width=2))
    dwg.save()

def watercolor_avatar(filename, size):
    dwg = svgwrite.Drawing(filename, size=(size, size))
    for _ in range(15):
        cx, cy = random.uniform(0, size), random.uniform(0, size)
        r = random.uniform(size*0.3, size*0.6)
        dwg.add(dwg.circle(center=(cx, cy), r=r, fill=random_color(), fill_opacity=0.2))
    dwg.save()

def pixel_avatar(filename, size):
    dwg = svgwrite.Drawing(filename, size=(size, size))
    grid = 8
    cell = size / grid
    for i in range(grid):
        for j in range(grid):
            if random.random() < 0.5:
                dwg.add(dwg.rect(
                    insert=(i*cell, j*cell),
                    size=(cell, cell),
                    fill=random_color()
                ))
    dwg.save()

def ornament_avatar(filename, size):
    dwg = svgwrite.Drawing(filename, size=(size, size))
    for x in range(0, size, 20):
        for y in range(0, size, 20):
            if random.random() < 0.7:
                dwg.add(dwg.circle(center=(x+10, y+10), r=5, fill=random_color()))
    dwg.save()

def biomorphic_avatar(filename, size):
    dwg = svgwrite.Drawing(filename, size=(size, size))
    points = [(random.uniform(0, size), random.uniform(0, size)) for _ in range(8)]
    dwg.add(dwg.polygon(points, fill=random_color()))
    dwg.save()

def cosmic_avatar(filename, size):
    dwg = svgwrite.Drawing(filename, size=(size, size))
    dwg.add(dwg.rect(insert=(0, 0), size=(size, size), fill='black'))
    for _ in range(50):
        x, y = random.uniform(0, size), random.uniform(0, size)
        r = random.uniform(1, 3)
        dwg.add(dwg.circle(center=(x, y), r=r, fill='white'))
    dwg.save()

def doodle_avatar(filename, size):
    dwg = svgwrite.Drawing(filename, size=(size, size))
    for _ in range(3):
        points = [(random.uniform(0, size), random.uniform(0, size)) for _ in range(5)]
        dwg.add(dwg.polyline(points, stroke=random_color(), fill='none', stroke_width=1))
    dwg.save()

def stripe_avatar(filename, size):
    dwg = svgwrite.Drawing(filename, size=(size, size))
    for i in range(0, size, 20):
        dwg.add(dwg.rect(insert=(0, i), size=(size, 10), fill=random_color()))
    dwg.save()

generators = [
    gradient_avatar, geometric_avatar, line_art_avatar, watercolor_avatar,
    pixel_avatar, ornament_avatar, biomorphic_avatar, cosmic_avatar,
    doodle_avatar, stripe_avatar
]

size = 256
for i, gen in enumerate(generators):
    filename = os.path.join(OUTPUT_DIR, f"avatar_{i}.svg")
    gen(filename, size)

print(OUTPUT_DIR)
